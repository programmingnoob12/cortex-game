// api/billing/rejoin.js
//
// Restarts a lapsed membership on the SAME Stripe customer and the SAME
// Supabase account.
//
// Sending a lapsed member to the public checkout instead is how accounts get
// split in two: the checkout provisions by email, so anyone who types a
// different address than they log in with gets a brand new account and their
// streak, scores and history are stranded on the old one. Because the person
// is already signed in here, none of that is necessary — their customer id
// and saved card are already known server-side.
import { stripe, getBillingContext, buildStateResponse, withBillingHandler, supabaseAdmin } from "./_lib.js";

export default withBillingHandler(async (req) => {
  const { plan } = req.body || {};
  const priceId =
    plan === "annual" ? process.env.STRIPE_PRICE_ANNUAL : process.env.STRIPE_PRICE_MONTHLY;
  if (!priceId) {
    const err = new Error("Plan pricing is not configured");
    err.status = 500;
    throw err;
  }

  const { userId, customerId, subscriptionId } = await getBillingContext(req);

  // If the old subscription is somehow still live, don't sell a second one.
  try {
    const existing = await stripe.subscriptions.retrieve(subscriptionId);
    if (["active", "trialing", "past_due"].includes(existing.status)) {
      return buildStateResponse(customerId, subscriptionId);
    }
  } catch {
    // Subscription genuinely gone — carry on and make a new one.
  }

  // Reuse whichever card they last saved. Without one there is nothing to
  // charge, so the caller falls back to the checkout page.
  const customer = await stripe.customers.retrieve(customerId);
  let paymentMethodId = customer?.invoice_settings?.default_payment_method || null;
  if (paymentMethodId && typeof paymentMethodId !== "string") {
    paymentMethodId = paymentMethodId.id;
  }
  if (!paymentMethodId) {
    const methods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
      limit: 1,
    });
    paymentMethodId = methods.data[0]?.id ?? null;
  }
  if (!paymentMethodId) {
    const err = new Error("NO_SAVED_CARD");
    err.status = 409;
    throw err;
  }

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    default_payment_method: paymentMethodId,
    expand: ["latest_invoice.payment_intent"],
    metadata: { product: "nback-membership", plan: plan === "annual" ? "annual" : "monthly" },
  });

  // The webhook keys off stripe_customer_id, so it can update the status but
  // not the id of a subscription it has never seen. Write it here.
  const { error: rowErr } = await supabaseAdmin
    .from("users")
    .update({
      stripe_subscription_id: subscription.id,
      membership_status: subscription.status === "active" ? "active" : "past_due",
    })
    .eq("id", userId);
  if (rowErr) console.error("rejoin row update failed:", rowErr.message);

  if (subscription.status !== "active") {
    const err = new Error(
      "That card was declined. Please update your card and try again."
    );
    err.status = 402;
    throw err;
  }

  return buildStateResponse(customerId, subscription.id);
});
