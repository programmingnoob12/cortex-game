// api/billing/reactivate.js
import { stripe, getBillingContext, buildStateResponse, withBillingHandler } from "./_lib.js";

export default withBillingHandler(async (req) => {
  const { customerId, subscriptionId } = await getBillingContext(req);
  await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
  return buildStateResponse(customerId, subscriptionId);
});
