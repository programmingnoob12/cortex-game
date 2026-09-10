// api/billing/streak-reward.js
//
// Grants the 7-day-streak reward: one free month, once per member, ever.
//
// The grant is a one-month extension of the current billing period rather
// than a coupon, because that is the one mechanism that behaves correctly on
// both plans without touching the plan itself. Stripe's `trial_end` moves the
// next invoice date; nothing is charged for the skipped month and the
// subscription keeps its own price, so:
//
//   monthly  — the next $40 lands a month later than it would have
//   annual   — the renewal lands a month later, so the free month is inserted
//              after the year they already paid for, exactly as intended
//
// and if they switch plans in between, the switch is unaffected: they resume
// on whatever plan they are on when billing restarts. A 100%-off coupon would
// have made an annual member's next *year* free, and a subscription schedule
// would have fought the plan-switch logic in switch.js.
//
// `trialing` is mapped to "active" by the webhook that owns
// membership_status, so the free month is full membership, not a lock screen.
//
// The claim is recorded in the subscription's own metadata. That is the
// durable record — the flag the app keeps in user_kv only saves a round trip,
// and is user-writable, so it is never what this endpoint trusts.
import { stripe, getBillingContext, buildStateResponse, withBillingHandler } from "./_lib.js";

const REWARD_METADATA_KEY = "streak_reward_at";

// Calendar month, not 30 days: a member whose period ends on the 12th should
// see the next charge on the 12th. Clamped for the short months, so a period
// ending 31 January extends to 28 February rather than rolling into March.
function plusOneMonth(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const day = d.getUTCDate();
  const target = new Date(d);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + 1);
  const lastDayOfTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDayOfTarget));
  return Math.floor(target.getTime() / 1000);
}

export default withBillingHandler(async (req) => {
  if (req.method !== "POST") {
    const err = new Error("Method not allowed");
    err.status = 405;
    throw err;
  }

  const { customerId, subscriptionId } = await getBillingContext(req);
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  // Once ever. Answering 200 rather than an error keeps this safe to call
  // from more than one device without the app having to coordinate.
  if (subscription.metadata?.[REWARD_METADATA_KEY]) {
    return {
      alreadyGranted: true,
      grantedAt: Number(subscription.metadata[REWARD_METADATA_KEY]) || null,
      ...(await buildStateResponse(customerId, subscriptionId)),
    };
  }

  // Only a live membership can have its next period pushed out. A paused,
  // past-due or cancelled subscription is not owed a free month, and setting
  // trial_end on one would produce nonsense.
  if (!["active", "trialing"].includes(subscription.status)) {
    const err = new Error("Membership is not active");
    err.status = 409;
    throw err;
  }
  if (subscription.cancel_at_period_end) {
    const err = new Error("Membership is already set to cancel");
    err.status = 409;
    throw err;
  }

  const freeUntil = plusOneMonth(subscription.current_period_end);

  await stripe.subscriptions.update(subscriptionId, {
    trial_end: freeUntil,
    // No credit, no immediate invoice — the only thing changing is when the
    // next charge happens.
    proration_behavior: "none",
    metadata: {
      ...(subscription.metadata || {}),
      [REWARD_METADATA_KEY]: String(Math.floor(Date.now() / 1000)),
    },
  });

  return {
    granted: true,
    freeUntil,
    ...(await buildStateResponse(customerId, subscriptionId)),
  };
});
