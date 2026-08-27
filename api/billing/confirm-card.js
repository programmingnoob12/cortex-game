// api/billing/confirm-card.js
//
// Called right after the browser confirms the SetupIntent.
//
// Confirming a SetupIntent only attaches the card to the CUSTOMER. It does
// not change which card the SUBSCRIPTION charges, and it does not change
// subscription.default_payment_method — which is exactly what
// buildStateResponse reads to show "Visa •••• 4242". Without this step the
// card block goes blank after a successful update, because the state call
// comes back with card: null.
import { stripe, getBillingContext, buildStateResponse, withBillingHandler } from "./_lib.js";

export default withBillingHandler(async (req) => {
  const { setupIntentId } = req.body || {};
  const { customerId, subscriptionId } = await getBillingContext(req);

  let paymentMethodId = null;

  if (setupIntentId) {
    const intent = await stripe.setupIntents.retrieve(setupIntentId);
    // Never trust an id from the client — only accept it if Stripe says it
    // belongs to this verified customer.
    if (intent.customer === customerId && intent.payment_method) {
      paymentMethodId =
        typeof intent.payment_method === "string"
          ? intent.payment_method
          : intent.payment_method.id;
    }
  }

  // Fallback for a missing or unusable intent id: take the customer's most
  // recently attached card.
  if (!paymentMethodId) {
    const methods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
      limit: 1,
    });
    paymentMethodId = methods.data[0]?.id ?? null;
  }

  if (!paymentMethodId) {
    const err = new Error("No saved card found for this account");
    err.status = 400;
    throw err;
  }

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  await stripe.subscriptions.update(subscriptionId, {
    default_payment_method: paymentMethodId,
  });

  return buildStateResponse(customerId, subscriptionId);
});
