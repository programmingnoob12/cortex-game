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
    // Fall back to the customer record. Stripe only attaches receipt_email
    // when the browser confirms, so abandoned or superseded intents arrive
    // here with none. Returning 400 for those made Stripe retry them
    // forever and count the endpoint as failing — 200 with nothing to do is
    // the correct answer for an event we legitimately cannot act on.
    let email = intent.receipt_email;
    if (!email && intent.customer) {
      const cid = typeof intent.customer === "string" ? intent.customer : intent.customer.id;
      try {
        const cust = await stripe.customers.retrieve(cid);
        if (!("deleted" in cust) || !cust.deleted) email = cust.email ?? null;
      } catch (err) {
        console.error("customer lookup failed:", err.message);
      }
    }
    if (!email) {
      console.log("no email on payment intent, skipping:", intent.id);
      return new Response(JSON.stringify({ received: true, skipped: "no email" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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

    // The checkout creates the Customer before an email exists (the page
    // has none to send), so stamp it on now that Stripe has one. Keeps the
    // Stripe dashboard readable and lets create-payment-intent reuse the
    // customer by email later if the checkout ever collects it up front.
    if (customerId && email) {
      try {
        await stripe.customers.update(customerId, { email });
      } catch (err) {
        console.error("customer email update error:", err.message);
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

    // admin.generateLink CREATES a link and returns it. It does not send
    // anything, which is why nobody ever received a login email after
    // paying. signInWithOtp on a normal (anon-key) client is what actually
    // hands the job to the configured SMTP sender.
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!anonKey) {
      console.error("SUPABASE_ANON_KEY missing — cannot send the login email");
    } else {
      const supabasePublic = createClient(Deno.env.get("SUPABASE_URL")!, anonKey);
      const { error: mailErr } = await supabasePublic.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: Deno.env.get("APP_URL") || undefined },
      });
      if (mailErr) {
        // Never fail the webhook over this. The account is already created
        // and active; worst case they request a sign-in link themselves.
        console.error("login email failed:", mailErr.message);
      }
    }
  }

  // Mirrors Stripe's live subscription state into membership_status.
  //
  // Without this, pause_collection stops the charges but the subscription
  // stays "active" in Stripe and nothing ever downgrades the account — a
  // paused member kept full access to every exercise while paying nothing,
  // repeatable indefinitely. The same gap let a failed card keep access for
  // the whole retry window before the subscription was finally cancelled.
  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;

    let status: string;
    if (subscription.pause_collection) {
      status = "paused";
    } else if (subscription.status === "past_due" || subscription.status === "unpaid") {
      status = "past_due";
    } else if (subscription.status === "canceled" || subscription.status === "incomplete_expired") {
      status = "inactive";
    } else if (subscription.status === "active" || subscription.status === "trialing") {
      status = "active";
    } else {
      // incomplete — the first payment has not landed yet, so no access.
      status = "inactive";
    }

    const { error: syncErr } = await supabaseAdmin
      .from("users")
      // current_period_end is what actually decides access. Pausing stops
      // future charges, but the period already paid for must still be
      // usable — locking someone out the moment they pause would take time
      // they bought. The app grants access while now < current_period_end,
      // whatever the status says, so a pause only bites once the paid
      // period runs out.
      .update({
        membership_status: status,
        current_period_end: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null,
        cancel_at_period_end: subscription.cancel_at_period_end ?? false,
      })
      .eq("stripe_customer_id", customerId);
    if (syncErr) {
      console.error("membership sync error:", syncErr.message);
      return new Response(`Could not sync membership: ${syncErr.message}`, { status: 500 });
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
