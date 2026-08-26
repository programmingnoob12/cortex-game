// api/billing/resume.js
import { stripe, getBillingContext, buildStateResponse, withBillingHandler } from "./_lib.js";

export default withBillingHandler(async (req) => {
  const { customerId, subscriptionId } = await getBillingContext(req);
  await stripe.subscriptions.update(subscriptionId, { pause_collection: "" });
  return buildStateResponse(customerId, subscriptionId);
});
