// api/billing/pause.js
//
// Pause is a monthly-plan feature. On an annual plan the person has already
// paid for the whole year, so freezing access mid-term just burns time they
// bought — the industry norm is to not offer pause on annual at all and let
// them switch to monthly or cancel at renewal instead. This endpoint
// enforces that server-side rather than trusting the UI to hide the button.
import { stripe, getBillingContext, buildStateResponse, withBillingHandler } from "./_lib.js";

const ALLOWED_MONTHS = [1, 2, 3];

export default withBillingHandler(async (req) => {
  const months = Number(req.body?.months) || 1;
  if (!ALLOWED_MONTHS.includes(months)) {
    const err = new Error("Pause length must be 1, 2 or 3 months");
    err.status = 400;
    throw err;
  }

  const { customerId, subscriptionId } = await getBillingContext(req);
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const interval = subscription.items.data[0]?.price?.recurring?.interval;

  if (interval === "year") {
    const err = new Error(
      "Pausing isn't available on the annual plan — it already runs for a year. Switch to monthly first, or cancel at renewal."
    );
    err.status = 400;
    throw err;
  }

  // The pause begins when the period they have already paid for runs out,
  // not the moment they press the button: that period is theirs either way,
  // so counting it as pause time would charge them for it twice over. A
  // one-month pause on a subscription renewing the 12th therefore resumes on
  // the 12th of the month after. Calendar months rather than 30-day blocks,
  // so "pause for 2 months" lands on the same day of the month.
  const periodEnd = subscription.current_period_end;
  const resumes = new Date((periodEnd ? periodEnd * 1000 : Date.now()));
  resumes.setMonth(resumes.getMonth() + months);
  const resumesAt = Math.floor(resumes.getTime() / 1000);

  await stripe.subscriptions.update(subscriptionId, {
    // "mark_uncollectible" means invoices during the pause are created but
    // marked uncollectible rather than charged — no card is touched while
    // paused, matching what "pause" should mean to a customer.
    pause_collection: { behavior: "mark_uncollectible", resumes_at: resumesAt },
    cancel_at_period_end: false,
  });

  return buildStateResponse(customerId, subscriptionId);
});
