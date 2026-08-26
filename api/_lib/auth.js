// Every billing endpoint is authenticated by the caller's own Supabase JWT,
// verified server-side. The client never tells us which customer it is — it
// proves who it is, and we look the customer up. Without this, anyone could
// cancel anyone else's subscription by passing a different id.
import { admin } from "./supabase.js";

export async function requireUser(req, res) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing authorization header" });
    return null;
  }

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: "Invalid session" });
    return null;
  }
  return data.user;
}

// Loads the billing row we keep alongside the auth user. Returns null (and
// answers the request) when there's no Stripe customer yet — every billing
// action needs one, and the caller shouldn't have to repeat the check.
export async function requireBilling(res, userId) {
  const { data, error } = await admin
    .from("users")
    .select(
      "id, membership_status, stripe_customer_id, stripe_subscription_id, plan, current_period_end, cancel_at_period_end"
    )
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Could not load billing record" });
    return null;
  }
  if (!data?.stripe_customer_id) {
    res.status(409).json({ error: "No Stripe customer for this account" });
    return null;
  }
  return data;
}

export function methodGuard(req, res, ...allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader("Allow", allowed.join(", "));
    res.status(405).json({ error: "Method not allowed" });
    return false;
  }
  return true;
}
