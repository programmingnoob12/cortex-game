// api/billing/cancel.js
import { stripe, getBillingContext, buildStateResponse, withBillingHandler } from "./_lib.js";

export default withBillingHandler(async (req) => {
  const { feedback, comment } = req.body || {};
  const { customerId, subscriptionId } = await getBillingContext(req);

  await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
    cancellation_details: {
      feedback: feedback || undefined,
      comment: comment || undefined,
    },
  });

  return buildStateResponse(customerId, subscriptionId);
});
