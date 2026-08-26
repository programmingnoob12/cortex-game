// api/billing/preview-switch.js
import { stripe, getBillingContext, withBillingHandler } from "./_lib.js";

// Server-side source of truth for price ids — the client sends "monthly" or
// "annual", never a raw Stripe price id, so a tampered request can't switch
// someone onto an arbitrary price.
const PRICE_IDS = {
  monthly: "price_REPLACE_WITH_MONTHLY_PRICE_ID",
  annual: "price_REPLACE_WITH_ANNUAL_PRICE_ID",
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

  const upcoming = await stripe.invoices.retrieveUpcoming({
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
