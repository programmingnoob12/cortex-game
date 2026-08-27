// api/billing/preview-switch.js
import { stripe, getBillingContext, withBillingHandler } from "./_lib.js";

// Server-side source of truth for price ids — the client sends "monthly" or
// "annual", never a raw Stripe price id, so a tampered request can't switch
// someone onto an arbitrary price.
const PRICE_IDS = {
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  annual: process.env.STRIPE_PRICE_ANNUAL,
};

export default withBillingHandler(async (req) => {
  const { plan } = req.body || {};
  const newPriceId = PRICE_IDS[plan];
  if (!newPriceId) {
    const err = new Error("Unknown plan");
    err.status = 400;
    throw err;
  }

  const { customerId, subscriptionId } = await getBillingContext(req);
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const currentItem = subscription.items.data[0];
  const prorationDate = Math.floor(Date.now() / 1000);

  // stripe-node v22 removed invoices.retrieveUpcoming in favour of
  // invoices.createPreview, and moved the subscription_* top-level params
  // under a subscription_details object. Older versions are kept working
  // by falling back, so this doesn't break if the SDK is pinned back.
  const upcoming = stripe.invoices.createPreview
    ? await stripe.invoices.createPreview({
        customer: customerId,
        subscription: subscriptionId,
        subscription_details: {
          items: [{ id: currentItem.id, price: newPriceId }],
          proration_date: prorationDate,
        },
      })
    : await stripe.invoices.retrieveUpcoming({
        customer: customerId,
        subscription: subscriptionId,
        subscription_items: [{ id: currentItem.id, price: newPriceId }],
        subscription_proration_date: prorationDate,
      });

  return {
    dueNow: upcoming.amount_due,
    currency: upcoming.currency,
    prorationDate,
    lines: upcoming.lines.data.map((line) => ({
      desc: line.description,
      amount: line.amount,
    })),
    nextRenewal: subscription.current_period_end,
  };
});
