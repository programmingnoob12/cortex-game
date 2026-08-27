// supabase/functions/create-subscription/index.ts
//
// Public checkout endpoint. Takes { email, plan } and returns a
// { clientSecret } that the browser's Stripe PaymentElement confirms.
//
// This is what makes the whole billing system work: it creates a real
// Stripe CUSTOMER and a real SUBSCRIPTION. The old checkout created a
// bare one-off PaymentIntent with customer:null and invoice:null, so the
// webhook had nothing to store and every /api/billing/* endpoint (switch,
// cancel, pause, card update) had no subscription to act on.
//
// Deploy with:
//   supabase functions deploy create-subscription --no-verify-jwt
//
// Required function secrets (supabase secrets set ...):
//   STRIPE_SECRET_KEY, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL

import Stripe from "https://esm.sh/stripe@14?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const PRICE_IDS: Record<string, string | undefined> = {
  monthly: Deno.env.get("STRIPE_PRICE_MONTHLY"),
  annual: Deno.env.get("STRIPE_PRICE_ANNUAL"),
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const fail = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("Method not allowed", 405);

  let body: { email?: string; plan?: string };
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body");
  }

  const email = (body.email || "").trim().toLowerCase();
  const plan = body.plan || "monthly";

  if (!email || !email.includes("@")) return fail("A valid email is required");

  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    return fail(
      `Unknown plan "${plan}" — set STRIPE_PRICE_MONTHLY / STRIPE_PRICE_ANNUAL as function secrets`,
      500
    );
  }

  try {
    // Reuse an existing customer for this email so repeat attempts don't
    // pile up duplicate customers in Stripe.
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer =
      existing.data[0] ?? (await stripe.customers.create({ email }));

    // If they already have a live subscription, don't sell them a second one.
    const live = await stripe.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 10,
    });
    const alreadyActive = live.data.find((s) =>
      ["active", "trialing", "past_due"].includes(s.status)
    );
    if (alreadyActive) {
      return new Response(
        JSON.stringify({
          alreadySubscribed: true,
          error: "This email already has an active membership — sign in instead.",
        }),
        { status: 409, headers: cors }
      );
    }

    // An incomplete subscription hands back a PaymentIntent to confirm in
    // the browser. Because the intent belongs to a subscription invoice,
    // it carries customer + invoice — which is exactly what the
    // stripe-webhook reads to fill stripe_customer_id and
    // stripe_subscription_id.
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription",
        payment_method_types: ["card"],
      },
      expand: ["latest_invoice.payment_intent"],
      metadata: { product: "nback-membership", plan },
    });

    // deno-lint-ignore no-explicit-any
    const invoice = subscription.latest_invoice as any;
    const intent = invoice?.payment_intent;

    if (!intent?.client_secret) {
      return fail("Stripe did not return a payment intent for this subscription", 500);
    }

    // The webhook provisions the Supabase account off receipt_email, so
    // stamp it here rather than relying on the browser to pass it through.
    await stripe.paymentIntents.update(intent.id, { receipt_email: email });

    return new Response(
      JSON.stringify({
        clientSecret: intent.client_secret,
        subscriptionId: subscription.id,
        customerId: customer.id,
      }),
      { status: 200, headers: cors }
    );
  } catch (err) {
    console.error("create-subscription error:", err);
    return fail(err instanceof Error ? err.message : "Could not start checkout", 500);
  }
});
