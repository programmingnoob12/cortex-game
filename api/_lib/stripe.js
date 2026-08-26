// Shared Stripe client. Vercel Functions are stateless but the module scope is
// reused across warm invocations, so this is created once per container rather
// than once per request.
import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is not set");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  // Pin the version so a Stripe-side upgrade can never change behaviour
  // under a deployed build. Bump deliberately, after reading the changelog.
  apiVersion: "2025-10-29.clover",
});

export const PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY;
export const PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL;

// Maps the plan names the client sends to real price ids, so a caller can
// never pass an arbitrary price and subscribe themselves to something cheap.
export function priceIdFor(plan) {
  if (plan === "monthly") return PRICE_MONTHLY;
  if (plan === "annual") return PRICE_ANNUAL;
  return null;
}

export function planFor(priceId) {
  if (priceId === PRICE_MONTHLY) return "monthly";
  if (priceId === PRICE_ANNUAL) return "annual";
  return "unknown";
}
