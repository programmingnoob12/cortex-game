// api/billing/switch.js
import { stripe, getBillingContext, buildStateResponse, withBillingHandler } from "./_lib.js";

const PRICE_IDS = {
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  annual: process.env.STRIPE_PRICE_ANNUAL,
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
  const currentInterval = currentItem?.price?.recurring?.interval;

  const isRevert =
    subscription.metadata?.scheduled_plan === "monthly" && plan === "annual";

  if (isRevert) {
    // Put the annual price back and clear the schedule. proration_behavior
    // "none" means no invoice and no credit — nothing was ever charged for
    // the pending change, so undoing it must cost nothing either.
    await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: currentItem.id, price: PRICE_IDS.annual }],
      proration_behavior: "none",
      cancel_at_period_end: false,
      metadata: {
        ...subscription.metadata,
        scheduled_plan: "",
        scheduled_plan_at: "",
      },
    });
    return buildStateResponse(customerId, subscriptionId);
  }

  const isDowngrade = currentInterval === "year" && plan === "monthly";

  if (isDowngrade) {
    // proration_behavior "none" changes the price without invoicing now and
    // without issuing credit. The current period still runs to the annual
    // renewal date, and the first monthly charge happens then. They keep
    // every day they paid for; no refund, no free months.
    await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: currentItem.id, price: newPriceId }],
      proration_behavior: "none",
      cancel_at_period_end: false,
      metadata: {
        ...subscription.metadata,
        scheduled_plan: "monthly",
        scheduled_plan_at: String(subscription.current_period_end),
      },
    });
    return buildStateResponse(customerId, subscriptionId);
  }

  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: currentItem.id, price: newPriceId }],
    proration_behavior: "create_prorations",
    // Reuses the exact proration_date the person already saw in the preview
    // step, so what they confirmed matches what actually bills — without
    // this, a few seconds' drift could change the amount charged.
    proration_date: prorationDate,
    cancel_at_period_end: false,
    metadata: {
      ...subscription.metadata,
      scheduled_plan: "",
      scheduled_plan_at: "",
    },
  });

  return buildStateResponse(customerId, subscriptionId);
});
