// api/billing/setup-intent.js
import { stripe, getBillingContext, withBillingHandler } from "./_lib.js";

export default withBillingHandler(async (req) => {
  const { customerId } = await getBillingContext(req);
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    automatic_payment_methods: { enabled: true },
  });
  return { clientSecret: setupIntent.client_secret };
});
