// api/billing/_lib.js
//
// Shared by every /api/billing/* route. Node.js serverless functions on
// Vercel (auto-detected from the /api folder — works alongside a plain
// Vite app, no framework needed) using the real npm `stripe` and
// `@supabase/supabase-js` packages (different runtime from the Deno-based
// Supabase Edge Functions built earlier — this is Node, those are Deno).

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Verifies the caller's Supabase access token and returns the row from
// public.users for that person — never trust a client-supplied customer
// or subscription id, always derive it server-side from the verified user.
export async function getBillingContext(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    const err = new Error("Not authenticated");
    err.status = 401;
    throw err;
  }

  const {
    data: { user },
    error: userErr,
  } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !user) {
    const err = new Error("Not authenticated");
    err.status = 401;
    throw err;
  }

  const { data: row, error: rowErr } = await supabaseAdmin
    .from("users")
    .select("stripe_customer_id, stripe_subscription_id")
    .eq("id", user.id)
    .maybeSingle();

  if (rowErr || !row?.stripe_customer_id || !row?.stripe_subscription_id) {
    const err = new Error("No billing account found for this user");
    err.status = 400;
    throw err;
  }

  return {
    userId: user.id,
    customerId: row.stripe_customer_id,
    subscriptionId: row.stripe_subscription_id,
  };
}

// Maps a Stripe subscription (+ its invoices) into the exact shape the
// frontend's mock already returns — every endpoint that changes the
// subscription re-fetches and returns this same shape, so the UI updates
// consistently no matter which action triggered it.
export async function buildStateResponse(customerId, subscriptionId) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["default_payment_method", "items.data.price"],
  });

  const item = subscription.items.data[0];
  const price = item?.price;
  const plan = price?.recurring?.interval === "year" ? "annual" : "monthly";

  const pm = subscription.default_payment_method;
  const card = pm?.card
    ? {
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
      }
    : null;

  const invoiceList = await stripe.invoices.list({ customer: customerId, limit: 10 });
  const invoices = invoiceList.data.map((inv) => ({
    id: inv.id,
    created: inv.created,
    amount: inv.amount_paid || inv.amount_due,
    status: inv.status,
    pdf: inv.invoice_pdf,
    url: inv.hosted_invoice_url,
  }));

  const openInvoice = invoiceList.data.find(
    (inv) => (inv.status === "open" || inv.status === "past_due") && inv.amount_due > 0
  );

  return {
    status: subscription.status,
    plan,
    priceId: price?.id ?? null,
    currency: subscription.currency,
    amount: price?.unit_amount ?? null,
    currentPeriodEnd: subscription.current_period_end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    pausedUntil: subscription.pause_collection?.resumes_at ?? null,
    card,
    invoices,
    openInvoiceId: openInvoice?.id ?? null,
  };
}

// Small wrapper so every route file can stay a few lines — handles CORS
// preflight, catches thrown errors (with their .status) uniformly, and
// always responds with JSON.
export function withBillingHandler(fn) {
  return async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }
    try {
      const result = await fn(req, res);
      res.status(200).json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  };
}
