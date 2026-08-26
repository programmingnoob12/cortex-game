// api/billing/state.js
import { getBillingContext, buildStateResponse, withBillingHandler } from "./_lib.js";

export default withBillingHandler(async (req) => {
  const { customerId, subscriptionId } = await getBillingContext(req);
  return buildStateResponse(customerId, subscriptionId);
});
