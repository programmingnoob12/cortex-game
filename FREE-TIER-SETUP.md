# Setting up the free tier

What the app already does, what the backend still needs, and the order to do it in.

The app side is finished and deployed. Everything below is Supabase and Stripe.

---

## What already works

**Sign-up exists.** The login screen calls `supabase.auth.signInWithOtp`, which creates
the auth user when the email is new. Anyone can already get an account by asking for a
magic link. Nothing to build.

**Free accounts can save.** `user_kv` RLS is `auth.uid() = user_id and shared = false`.
It does not require a row in `users`, so a free account's CCT history persists from the
first session.

**The app knows which kind of account it is.** `AuthGate` reads
`users.membership_status`, and `MembershipContext` carries the answer to every gate:

| membership_status | What the app does |
|---|---|
| `active`, or inside a paid period | Full member |
| no row at all, or `free` | Free account, Anti-brainrot only |
| `paused`, `past_due`, `inactive`, `expired` | Held at the lock screen with its own way back |

---

## Step 1. Pick one webhook. This is the one that costs money.

There are two live handlers writing `membership_status`, and `BILLING.md` already warns
they will fight:

- `supabase/functions/stripe-webhook/index.ts` (edge function)
- `api/stripe/webhook.js` (Vercel)

The Vercel one **cannot upgrade a free account**. It resolves the person with:

```js
async function findUser({ customerId, email }) {
  if (customerId) { /* look up users.stripe_customer_id */ }
  if (email)      { /* look up users.email */ }
  return null;
}
```

Both lookups hit the `users` table. A free account has no row there, so `findUser`
returns `null`, `applySubscription` returns early, and the payment changes nothing. The
person pays and stays free.

The edge function survives by accident: `auth.admin.createUser` fails on the existing
email, it falls back to `listUsers`, finds them, and upserts the `users` row.

**Do this:** disable one endpoint in the Stripe dashboard so only one is receiving
events. Then make the survivor resolve in this order:

1. `users.stripe_customer_id` matches
2. `users.email` matches
3. **an auth user already exists with that email** (the free account) — reuse that id
4. otherwise create the auth user

Step 3 is the one that is missing today, and it is the whole upgrade path.

**Test:** sign up free with a fresh email, pay with that same email, and confirm you end
up with one auth user, one `users` row, and `membership_status = 'active'`. If you get
two accounts, step 3 is not working.

---

## Step 2. Give free accounts a row in `users`

Today "free" means "no row at all". The app copes, but you cannot count free users, and
the webhook has nothing to match on.

Allow the status first. The current constraint is:

```sql
membership_status in ('active','past_due','paused','expired','inactive')
```

Add `'free'` to it, and default new rows to `'free'` rather than `'inactive'` (today's
default means a brand-new row would read as a lapsed member and lock them out).

There is deliberately no INSERT policy on `users` (service_role only), so the row has to
be created server-side. Two options:

- **A Postgres trigger on `auth.users` insert.** Fires for every signup with no app
  change and no round trip. This is the one I would pick.
- **A small edge function** the app calls once after first sign-in. More moving parts and
  it can fail silently.

Whichever you choose, it must be idempotent: the Stripe webhook upserts the same row.

---

## Step 3. Reconcile the two migrations

`supabase/migrations/` has `20260824_billing_columns.sql` and
`20260827_billing_columns.sql`, near-identical, with the 0827 header saying 0824 was
never applied. They disagree on one thing: 0824 declares `stripe_customer_id text unique`,
0827 declares it without `unique`.

Keep the unique constraint. Without it two `users` rows can carry the same Stripe
customer and the webhook's lookup becomes non-deterministic.

Check what is actually applied in the database rather than trusting the files, then
delete the one that is not.

---

## Step 4. Enforce the free tier server-side

The gate is client-side. `user_kv` will accept a free account writing `history-quad`
today. Nothing stops a technical person from training everything free.

Fix by adding a `WITH CHECK` on the `user_kv` policy that restricts which keys a
non-member may write. The free keys are `stats-cct`, `history-cct`, and the various
`cortex.*` preference keys.

Not urgent. It is the difference between a paywall and a suggestion, and it can wait
until people are actually paying.

---

## Step 5. Sign-in copy

The screen says "Sign in" and nothing tells a new person they can start without paying.
Worth a line: "Sign in or start free", with a note that Anti-brainrot is free.

Small, but it is the entire top of the funnel.

---

## Order

1. Webhook consolidation and the auth-user-by-email lookup (Step 1)
2. `users` row on signup, plus the `'free'` status (Step 2)
3. Migration cleanup (Step 3)
4. Sign-in copy (Step 5)
5. Server-side enforcement (Step 4), once there is revenue to protect

Steps 1 and 2 are the only ones that block a free user from ever becoming a paying one.
