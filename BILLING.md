# Billing setup

Framework for in-app subscription management: plan switching, cancellation,
card replacement, failed-payment recovery. Checkout (first purchase) is
unchanged — this is everything *after* it.

## What was added

    api/_lib/stripe.js            Stripe client, price-id mapping
    api/_lib/supabase.js          service-role Supabase client (server only)
    api/_lib/auth.js              JWT verification + billing row lookup
    api/billing/subscription.js   GET   current plan, renewal date, card
    api/billing/preview-switch.js POST  exact prorated amount
    api/billing/switch.js         POST  apply the plan change
    api/billing/cancel.js         POST  cancel at period end + feedback
    api/billing/reactivate.js     POST  undo a pending cancellation
    api/billing/pause.js          POST  pause / resume collection
    api/billing/setup-intent.js   POST  client secret for the card form
    api/billing/payment-methods.js GET/POST/DELETE  saved cards
    api/billing/invoices.js       GET   billing history + open invoice
    api/billing/retry-invoice.js  POST  pay an open invoice now
    api/stripe/webhook.js         POST  the only writer of membership state
    src/billing.js                client helper + Elements appearance
    supabase/migrations/…sql      billing columns, constraint, RLS policy

Nothing existing was modified.

## Setup

**1. Dependencies**

    npm install stripe @stripe/stripe-js @stripe/react-stripe-js

`stripe` is server-only; the two `@stripe/*` packages are for the card form.

**2. Database**

Run `supabase/migrations/20260824_billing_columns.sql` against the project
(SQL editor, or `supabase db push`). It adds `stripe_customer_id`,
`stripe_subscription_id`, `plan`, `current_period_end`,
`cancel_at_period_end`, and an RLS policy letting a user read only their own
row.

**3. Environment**

Copy `.env.example`. Set the `VITE_*` values in `.env.local` and *all* of
them in Vercel (Project Settings → Environment Variables). Anything without
the `VITE_` prefix stays server-side; anything with it is compiled into the
bundle, so the service role key and secret key must never carry that prefix.

**4. Webhook**

Stripe Dashboard → Developers → Webhooks → Add endpoint:

    https://<your-domain>/api/stripe/webhook

Events: `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.paid`, `invoice.payment_failed`.

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

> If you already have a webhook running elsewhere, pick one. Two endpoints
> both writing `membership_status` will fight, and the loser is whichever
> arrives second.

**5. Local testing**

    stripe listen --forward-to localhost:3000/api/stripe/webhook
    vercel dev

`vite dev` alone won't serve `/api` — use `vercel dev` so the functions run.

## Architecture

The browser never sends a customer, subscription or price id. It sends its
own Supabase JWT; the server verifies it, looks up the Stripe customer, and
maps a plan name (`"monthly"` / `"annual"`) to a real price id from env. That
closes the obvious hole where a caller subscribes themselves to a cheaper
price, or cancels someone else's subscription.

`membership_status` is written **only** by the webhook. The endpoints return
what the UI should do next; they never write membership state, because a
client-driven write is lost when a tab closes mid-request.

Webhook handlers are idempotent — Stripe retries, and duplicate delivery is
normal. Replaying an event re-applies the same state.

## UI still to build

Endpoints are done; the screens aren't. Per flow:

- **Membership** — plan, price, renewal date, card on file, from
  `getSubscription()`. Plus a `past_due` banner when status says so.
- **Switch** — plan choice → `previewSwitch()` → confirm screen showing
  `dueNow` and the proration lines → `switchPlan(plan, prorationDate)`. If
  the response has `requiresAction`, confirm `clientSecret` client-side.
- **Cancel** — `CANCEL_REASONS` radios + comment → save offer matched to the
  reason (pause for `unused`, monthly plan for `too_expensive`) → `cancel()`.
  Then show "access until <date>" with an Undo calling `reactivate()`.
- **Cards** — `getCards()` list, `createSetupIntent()` + `PaymentElement`
  with `STRIPE_APPEARANCE`, then `setDefaultCard()`. `removeCard()` returns
  409 when it would strand the subscription.
- **History** — `getInvoices()`, linking `receiptUrl` / `pdfUrl`.
