// api/billing/retry-invoice.js
import { stripe, getBillingContext, buildStateResponse, withBillingHandler } from "./_lib.js";

export default withBillingHandler(async (req) => {
  const { customerId, subscriptionId } = await getBillingContext(req);

  const invoiceList = await stripe.invoices.list({ customer: customerId, limit: 5 });
  const openInvoice = invoiceList.data.find(
    (inv) => (inv.status === "open" || inv.status === "past_due") && inv.amount_due > 0
  );

  if (openInvoice) {
    await stripe.invoices.pay(openInvoice.id);
  }

  return buildStateResponse(customerId, subscriptionId);
});
