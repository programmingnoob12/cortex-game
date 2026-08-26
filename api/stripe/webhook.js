// POST /api/stripe/webhook
// The ONLY place membership state is written. Never let the browser tell the
// server "my switch succeeded, update my row" — that write is lost when a tab
// closes mid-request, and forgeable when it doesn't.
//
// Stripe dashboard -> Developers -> Webhooks -> add endpoint:
//   https://<your-domain>/api/stripe/webhook
// Subscribe to: checkout.session.completed, customer.subscription.created,
// customer.subscription.updated, customer.subscription.deleted,
// invoice.paid, invoice.payment_failed
import { stripe, planFor } from "../_lib/stripe.js";
import { admin } from "../_lib/supabase.js";

// Signature verification needs the raw bytes — any JSON parsing upstream
// changes them and every event fails verification.
export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

// Resolves our user row from whatever the event gives us. Stripe customer id
// is the durable link; the email fallback covers the very first webhook after
// a Checkout session, before the id has been stored.
async function findUser({ customerId, email }) {
  if (customerId) {
    const { data } = await admin
      .from("users")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    if (data) return data.id;
  }
  if (email) {
    const { data } = await admin
      .from("users")
      .select("id")
      .ilike("email", email)
      .maybeSingle();
    if (data) return data.id;
  }
  return null;
}

async function applySubscription(sub) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const userId = await findUser({ customerId });
  if (!userId) return;

  // Stripe's status is the source of truth. Map it once, here, so the rest of
  // the app only ever reads membership_status.
  const status =
    sub.status === "active" || sub.status === "trialing"
      ? "active"
      : sub.status === "past_due" || sub.status === "unpaid"
      ? "past_due"
      : sub.status === "paused"
      ? "paused"
      : "inactive";

  await admin
    .from("users")
    .update({
      membership_status: status,
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.id,
      plan: planFor(sub.items.data[0]?.price?.id),
      current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
      cancel_at_period_end: sub.cancel_at_period_end,
    })
    .eq("id", userId);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end();
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      await rawBody(req),
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    // Bad signature: refuse loudly. Anything else here means the endpoint is
    // misconfigured, and retrying won't fix it.
    return res.status(400).json({ error: `Webhook signature failed: ${err.message}` });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        // First purchase. Link the Stripe customer to the account so every
        // later event can be resolved by customer id alone.
        const s = event.data.object;
        const userId = await findUser({
          customerId: s.customer,
          email: s.customer_details?.email || s.customer_email,
        });
        if (userId) {
          await admin
            .from("users")
            .update({ stripe_customer_id: s.customer, membership_status: "active" })
            .eq("id", userId);
        }
        if (s.subscription) {
          await applySubscription(await stripe.subscriptions.retrieve(s.subscription));
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
        // Covers plan switches, pending cancellations, reactivations, pauses,
        // and 3DS completions — one handler, because they're all just a new
        // subscription state.
        await applySubscription(event.data.object);
        break;

      case "customer.subscription.deleted": {
        // Fires at period end, not when cancel was clicked.
        const sub = event.data.object;
        const userId = await findUser({ customerId: sub.customer });
        if (userId) {
          await admin
            .from("users")
            .update({
              membership_status: "expired",
              stripe_subscription_id: null,
              cancel_at_period_end: false,
            })
            .eq("id", userId);
        }
        break;
      }

      case "invoice.paid": {
        const inv = event.data.object;
        if (inv.subscription) {
          await applySubscription(await stripe.subscriptions.retrieve(inv.subscription));
        }
        break;
      }

      case "invoice.payment_failed": {
        const inv = event.data.object;
        const userId = await findUser({ customerId: inv.customer });
        if (userId) {
          await admin.from("users").update({ membership_status: "past_due" }).eq("id", userId);
        }
        break;
      }

      default:
        // Unhandled types are fine — acknowledge so Stripe stops retrying.
        break;
    }
  } catch (err) {
    // A 500 makes Stripe retry, which is what we want for a transient failure.
    // Handlers are written to be idempotent, so a replay is harmless.
    console.error("webhook handler failed", event.type, err);
    return res.status(500).json({ error: "Handler failed" });
  }

  res.status(200).json({ received: true });
}
