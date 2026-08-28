// supabase/functions/create-payment-intent/index.ts
//
// The checkout page at cortex-app-beryl.vercel.app calls THIS function on
// page load, with no request body, and expects { clientSecret } back.
//
// It used to create a bare one-off $40 PaymentIntent: customer null,
// invoice null, no Subscription anywhere. That is why every paid account
// ended up with stripe_customer_id and stripe_subscription_id NULL, and
// why the Membership screen said "No billing account found" — there was
// no subscription for switch / cancel / pause / card-update to act on.
//
// Now it creates a real Customer + a real Subscription and hands back the
// subscription's first-invoice PaymentIntent. The response shape is
// identical, so the existing checkout page needs no change.
//
// The page has no email at this point (Stripe collects it in the payment
// form and attaches it as receipt_email on confirm), so the Customer is
// created without one and the webhook fills it in afterwards.
//
// Deploy with:
//   supabase functions deploy create-payment-intent --no-verify-jwt
//
// Required function secrets:
//   STRIPE_SECRET_KEY, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_ANNUAL

import Stripe from "https://esm.sh/stripe@14?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

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

  // Currencies the Price actually carries in currency_options. Anything
  // else falls back to the Price's base currency, which is NZD — a Stripe
  // error is worse than charging a Brazilian customer in NZD and letting
  // their bank convert.
  const SUPPORTED_CURRENCIES = ["nzd", "aud", "usd", "gbp", "eur", "cad"];
  const DEFAULT_CURRENCY = "nzd";

  let email: string | undefined;
  let plan = "monthly";
  let currency = DEFAULT_CURRENCY;
  try {
    const body = await req.json();
    if (body?.email && typeof body.email === "string") {
      email = body.email.trim().toLowerCase();
    }
    if (body?.plan === "annual") plan = "annual";
    const wanted = String(body?.currency || "").toLowerCase();
    if (SUPPORTED_CURRENCIES.includes(wanted)) currency = wanted;
  } catch {
    // no body — an older checkout page, defaults to monthly in NZD
  }

  const priceId =
    plan === "annual"
      ? Deno.env.get("STRIPE_PRICE_ANNUAL")
      : Deno.env.get("STRIPE_PRICE_MONTHLY");
  if (!priceId) {
    return fail(
      `Pricing for the ${plan} plan is not configured on this project`,
      500
    );
  }

  try {
    const customer = await stripe.customers.create(
      email ? { email } : { description: "Cortex membership checkout" }
    );

    // default_incomplete creates the subscription in a state that waits on
    // the browser confirming the first invoice's PaymentIntent. That intent
    // carries customer + invoice, which is exactly what stripe-webhook
    // reads to populate stripe_customer_id / stripe_subscription_id.
    // Going Back on the card step and forward again asks for a new
    // subscription each time, so without this a hesitant customer leaves a
    // trail of half-made ones. Stripe expires incomplete subscriptions
    // after about a day anyway, but the dashboard is unreadable in the
    // meantime and a stale one can be confirmed by a stale client secret.
    try {
      const incomplete = await stripe.subscriptions.list({
        customer: customer.id,
        status: "incomplete",
        limit: 10,
      });
      for (const old of incomplete.data) {
        await stripe.subscriptions.cancel(old.id);
      }
    } catch (err) {
      console.error("could not clear incomplete subscriptions:", err);
    }

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      // Without this Stripe uses the Price's base currency and the
      // currency_options set on it are never reached.
      currency,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent"],
      metadata: { product: "nback-membership", plan, currency },
    });

    // deno-lint-ignore no-explicit-any
    const invoice = subscription.latest_invoice as any;
    const clientSecret = invoice?.payment_intent?.client_secret;

    if (!clientSecret) {
      console.error("no payment_intent on subscription", subscription.id);
      return fail("Stripe did not return a payment intent for this subscription", 500);
    }

    return new Response(
      JSON.stringify({
        clientSecret,
        currency,
        subscriptionId: subscription.id,
        customerId: customer.id,
      }),
      { status: 200, headers: cors }
    );
  } catch (err) {
    console.error("create-payment-intent error:", err);
    return fail(err instanceof Error ? err.message : "Could not start checkout", 500);
  }
});
