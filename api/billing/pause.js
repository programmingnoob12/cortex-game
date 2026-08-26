// api/billing/pause.js
import { stripe, getBillingContext, buildStateResponse, withBillingHandler } from "./_lib.js";

const PAUSE_DAYS = 30;

export default withBillingHandler(async (req) => {
  const { customerId, subscriptionId } = await getBillingContext(req);
  const resumesAt = Math.floor(Date.now() / 1000) + PAUSE_DAYS * 86400;

  await stripe.subscriptions.update(subscriptionId, {
    // "mark_uncollectible" means invoices during the pause are created but
    // marked uncollectible rather than charged — no card is touched while
    // paused, matching what "pause" should mean to a customer.
    pause_collection: { behavior: "mark_uncollectible", resumes_at: resumesAt },
    cancel_at_period_end: false,
  });

  return buildStateResponse(customerId, subscriptionId);
});
