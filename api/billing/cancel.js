// api/billing/cancel.js
import { stripe, getBillingContext, buildStateResponse, withBillingHandler } from "./_lib.js";
import { sendCancellationEmail } from "./_mail.js";

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

  // Emailed after the cancellation is already saved, and swallowed on
  // failure — a bad SMTP password must not make a cancellation look broken
  // to the person clicking the button.
  try {
    const customer = await stripe.customers.retrieve(customerId);
    await sendCancellationEmail({
      customerEmail: customer?.email,
      feedback,
      comment,
      subscriptionId,
    });
  } catch (err) {
    console.error("cancellation email failed:", err?.message);
  }

  return buildStateResponse(customerId, subscriptionId);
});
