// api/billing/switch.js
import { stripe, getBillingContext, buildStateResponse, withBillingHandler } from "./_lib.js";

const PRICE_IDS = {
  monthly: "price_REPLACE_WITH_MONTHLY_PRICE_ID",
  annual: "price_REPLACE_WITH_ANNUAL_PRICE_ID",
};

export default withBillingHandler(async (req) => {
  const { plan, prorationDate } = req.body || {};
  const newPriceId = PRICE_IDS[plan];
  if (!newPriceId) {
    const err = new Error("Unknown plan");
    err.status = 400;
    throw err;
  }

  const { customerId, subscriptionId } = await getBillingContext(req);
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const currentItem = subscription.items.data[0];

  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: currentItem.id, price: newPriceId }],
    proration_behavior: "create_prorations",
    // Reuses the exact proration_date the person already saw in the
    // preview step, so what they confirmed matches what actually bills —
    // without this, a few seconds' drift could change the amount charged.
    proration_date: prorationDate,
    cancel_at_period_end: false,
  });

  return buildStateResponse(customerId, subscriptionId);
});
