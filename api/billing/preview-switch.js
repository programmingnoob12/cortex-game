// api/billing/preview-switch.js
import { stripe, getBillingContext, withBillingHandler } from "./_lib.js";

// Server-side source of truth for price ids — the client sends "monthly" or
// "annual", never a raw Stripe price id, so a tampered request can't switch
// someone onto an arbitrary price.
const PRICE_IDS = {
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  annual: process.env.STRIPE_PRICE_ANNUAL,
};

export default withBillingHandler(async (req) => {
  const { plan } = req.body || {};
  const newPriceId = PRICE_IDS[plan];
  if (!newPriceId) {
    const err = new Error("Unknown plan");
    err.status = 400;
    throw err;
  }

  const { customerId, subscriptionId } = await getBillingContext(req);
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const currentItem = subscription.items.data[0];
  const currentInterval = currentItem?.price?.recurring?.interval;

  // DOWNGRADE (annual -> monthly): deferred to renewal, never prorated.
  //
  // Switching immediately would refund most of an unused year as account
  // credit, which then silently pays for months of monthly billing — the
  // customer appears to get free months and the revenue is already gone.
  // Waiting until renewal means they use the year they paid for, then start
  // monthly. No credit is created, no money moves early, nobody loses out.
  if (currentInterval === "year" && plan === "monthly") {
    return {
      deferred: true,
      dueNow: 0,
      currency: subscription.currency,
      effectiveDate: subscription.current_period_end,
      lines: [],
    };
  }

  // UPGRADE (monthly -> annual): immediate, prorated to the second. Unused
  // time on the current month is credited against the annual charge.
  const prorationDate = Math.floor(Date.now() / 1000);

  const upcoming = stripe.invoices.createPreview
    ? await stripe.invoices.createPreview({
        customer: customerId,
        subscription: subscriptionId,
        subscription_details: {
          items: [{ id: currentItem.id, price: newPriceId }],
          proration_date: prorationDate,
        },
      })
    : await stripe.invoices.retrieveUpcoming({
        customer: customerId,
        subscription: subscriptionId,
        subscription_items: [{ id: currentItem.id, price: newPriceId }],
        subscription_proration_date: prorationDate,
      });

  return {
    deferred: false,
    dueNow: upcoming.amount_due,
    // total is the sum of the line items. starting_balance is stored credit
    // being applied (negative when credit exists). Without surfacing it,
    // "Due now" can look wrong — lines adding to $440 while only cents are
    // charged because credit covers the rest.
    total: upcoming.total,
    creditApplied: upcoming.starting_balance || 0,
    currency: upcoming.currency,
    prorationDate,
    lines: upcoming.lines.data.map((line) => ({
      desc: line.description,
      amount: line.amount,
    })),
    nextRenewal: subscription.current_period_end,
  };
});
