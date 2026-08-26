// supabase/functions/stripe-webhook/index.ts
//
// Stripe calls this the moment a payment actually succeeds. This is the
// ONLY place a Supabase account gets created. Uses the service_role key
// (full access, bypasses Row-Level Security) since this runs as trusted
// backend code, never in the browser.
//
// Deploy with: supabase functions deploy stripe-webhook --no-verify-jwt
// (the --no-verify-jwt flag matters — Stripe calls this directly, not as
// a logged-in user, so it can't send a Supabase auth token)
//
// In the Stripe Dashboard, this endpoint needs BOTH events selected now:
// payment_intent.succeeded AND customer.subscription.deleted (edit the
// existing webhook endpoint -> add the second event type).

import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const serviceKey = Deno.env.get("LEGACY_SERVICE_ROLE_KEY");
console.log("LEGACY_SERVICE_ROLE_KEY present:", !!serviceKey, "starts with:", serviceKey?.slice(0, 8));

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  serviceKey!
);

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature")!;
  const body = await req.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (err) {
    return new Response(`Webhook signature verification failed: ${err.message}`, { status: 400 });
  }

  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object as Stripe.PaymentIntent;
    const email = intent.receipt_email;
    if (!email) {
      return new Response("No email on payment intent — cannot provision account", { status: 400 });
    }

    // Subscriptions attach their first invoice's PaymentIntent — pull the
    // customer id straight off the intent (Stripe sets this automatically
    // for subscription-created intents), and the subscription id via the
    // invoice it belongs to.
    const customerId =
      typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
    let subscriptionId: string | null = null;
    if (intent.invoice) {
      const invoiceId = typeof intent.invoice === "string" ? intent.invoice : intent.invoice.id;
      try {
        const invoice = await stripe.invoices.retrieve(invoiceId);
        subscriptionId =
          typeof invoice.subscription === "string"
            ? invoice.subscription
            : invoice.subscription?.id ?? null;
      } catch (err) {
        console.error("invoice retrieve error:", err.message);
      }
    }

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
    });

    let userId = created?.user?.id;
    if (createErr) {
      console.error("createUser error:", createErr.message);
      const { data: existing, error: listErr } = await supabaseAdmin.auth.admin.listUsers();
      if (listErr) {
        console.error("listUsers error:", listErr.message);
        return new Response(`Could not list users: ${listErr.message}`, { status: 500 });
      }
      userId = existing?.users.find((u) => u.email === email)?.id;
      if (!userId) {
        return new Response(`Could not create or find user: ${createErr.message}`, { status: 500 });
      }
    }

    const { error: upsertErr } = await supabaseAdmin.from("users").upsert({
      id: userId,
      email,
      membership_status: "active",
      stripe_customer_id: customerId ?? null,
      stripe_subscription_id: subscriptionId,
    });
    if (upsertErr) {
      console.error("users upsert error:", upsertErr.message);
      return new Response(`Could not activate membership: ${upsertErr.message}`, { status: 500 });
    }

    const { error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkErr) {
      console.error("generateLink error:", linkErr.message);
      // Don't fail the whole webhook over this — the account is already
      // created and active at this point, they can just request a login
      // link normally instead.
    }
  }

  // Fires when a subscription actually ends — either cancel_at_period_end
  // reaching its date, or an immediate cancellation. This is the real
  // "membership is now over" moment, distinct from clicking Cancel (which
  // just schedules the end-of-period cancellation via the earlier
  // cancel-subscription function).
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId =
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

    const { error: deactivateErr } = await supabaseAdmin
      .from("users")
      .update({ membership_status: "inactive" })
      .eq("stripe_customer_id", customerId);
    if (deactivateErr) {
      console.error("membership deactivation error:", deactivateErr.message);
      return new Response(`Could not deactivate membership: ${deactivateErr.message}`, {
        status: 500,
      });
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
