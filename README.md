# 💧 Waterdrop — Smart Water Can Management & Delivery

**Never Run Out of Water.** · *தண்ணீர் தீரும் முன் Waterdrop!*

Waterdrop keeps an accurate count of every 20-litre water can, from supplier delivery to the last glass.
Customers always know how many cans they have and when to reorder. Suppliers bill exactly what customers
confirmed they received.

| Problem | How Waterdrop solves it |
|---|---|
| Suppliers deliver fewer cans than expected | Stock and bills use **customer-confirmed** quantities only. Shortages are recorded and reported. |
| Customers don't know their stock | An append-only inventory ledger gives the live balance: opening + confirmed received − consumed − returned/damaged ± adjustments. |
| Customers forget to order | Prediction uses 7-day usage and supplier lead time. One alert per low/critical episode, plus an "order now" recommendation. |
| Manual delivery schedules | Order workflow: pending → accepted (scheduled) → preparing → out for delivery → delivered. |
| Month-end billing | Bills are generated automatically and idempotently from confirmed deliveries, with balances carried forward and partial payments. Exported as PDF. |

---

## Tech stack

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui-style components (Radix), Lucide, TanStack Query
- **Backend:** Supabase (PostgreSQL 17, Auth, Row Level Security, Realtime, Storage, Edge Functions on Deno)
- **Scheduling:** `pg_cron` (plus an HTTP job endpoint for any external scheduler)
- **PDF:** jsPDF + jspdf-autotable (loaded on demand)
- **Email:** Resend · **WhatsApp (optional):** Meta WhatsApp Cloud API · **Payments:** Razorpay
- **Hosting:** Cloudflare Workers (static assets, SPA routing) + Supabase

## Repository layout

```
src/
  auth/              session/profile provider, role guards
  components/        ui/ (button, card, dialog, table…), brand/Logo, water/StockGauge, layouts
  lib/domain/        pure business rules (stock, prediction, billing, orders) + tests
  lib/pdf/           invoice & report PDF generation
  pages/public       landing, sign in/up, onboarding, invite links
  pages/customer     home, order, orders, deliveries, usage, bills, settings
  pages/supplier     dashboard, customers, deliveries, orders, inventory, bills, payments, reports, settings
  pages/admin        platform overview, suppliers, customers, plans, system activity
supabase/
  migrations/        schema, RLS, ledger engine, operations, billing, jobs, storage, cron
  functions/         dispatch-notifications, create-payment-order, payment-webhook, run-scheduled-jobs
  tests/             SQL test suites (inventory, orders, billing, RLS) + Supabase shim
  seed.sql           local demo accounts and data
scripts/db-test.sh   runs migrations + SQL tests against a throwaway PostgreSQL
```

---

## Quick start (local)

Requirements: Node 20+, Docker, and the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
npm install
supabase start                 # applies migrations + seed.sql to a local stack
cp .env.example .env.local     # then paste the API URL + anon key printed by `supabase start`
npm run dev                    # http://localhost:5173
```

Demo accounts from `supabase/seed.sql` (local only). The password for all three is `Waterdrop123!`:

| Email | Role |
|---|---|
| `customer@waterdrop.test` | Customer (Meena) with stock history, a bill, a pending order and a delivery to confirm |
| `supplier@waterdrop.test` | Supplier "Blue Spring Waters" |
| `admin@waterdrop.test` | Platform admin |

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Type-check + production build |
| `npm run lint` | ESLint |
| `npm test` | Unit tests: domain rules, CSV export, webhook signature verification |
| `npm run test:db` | Applies all migrations to a throwaway PostgreSQL and runs the SQL suites: stock maths, delivery confirmation, consumption, alerts, prediction, orders, billing, partial payments, duplicate-invoice prevention, RLS |

`test:db` needs a local PostgreSQL install (`postgres`, `initdb`, `psql`). Set `PGBIN` if the binaries aren't in
`/usr/lib/postgresql/<version>/bin`.

---

## How the core rules work

### Inventory ledger
- `inventory_transactions` is **append-only**: database triggers reject updates and deletes. Each row stores a
  signed quantity and the resulting `balance_after`.
- `customer_stock.current_stock` is a cached balance that only the ledger trigger maintains. It has a
  `CHECK (current_stock >= 0)` constraint.
- Opening stock can be set **once**. After that, stock changes only through confirmed deliveries, consumption,
  returns, damage, and adjustments, and every adjustment needs a reason and records who made it.

### Delivery confirmation
1. The supplier records the **expected** and **actual** quantities. The delivery waits in `awaiting_confirmation`.
2. The customer is notified and confirms how many cans they **received**.
3. Only the confirmed quantity is posted to the ledger. The ledger key `delivery:<id>` is unique, and a row
   lock means a duplicate confirmation is rejected.
4. `discrepancy` (confirmed − expected) and `claim_gap` (confirmed − supplier-claimed) feed the accuracy report.
   Shortages notify the supplier.
5. A confirmed delivery is frozen. A correction creates a `delivery_adjustments` row plus a ledger delta, keeps
   the original record, and is billed in the next cycle.
6. **Offline customers** (no app account) are confirmed by the supplier on their behalf, and those deliveries
   are flagged `confirmed_by_supplier`.

Spec scenario, covered by both SQL and unit tests: opening 5, expected 10, actual 8, confirmed 8 → **13**.
Consuming 2 a day gives **11**, then **9**. If the customer confirms only 7 → **12**.

### Consumption
- There is one record per customer per local day (unique constraint). Editing a day posts only the difference.
- Consumption beyond available stock never makes stock negative. The shortfall is recorded as
  `unmet_quantity`, with a `stockout` ledger event.
- Customers can edit the last 7 days themselves. Older days go through a **correction request** that the
  supplier approves.
- **Automatic daily consumption** runs every 15 minutes. It uses each customer's timezone and chosen time,
  creates the day's record only if none exists, and catches up at most 2 missed days.

### Prediction
- Average = consumption over the recorded span in the last 7 days. It needs at least 3 recorded days, and
  otherwise falls back to the configured daily consumption.
- `days_remaining = stock / avg`, and `empty_date = today + floor(days_remaining)`.
- Order now when `days_remaining ≤ lead_days + 1` or stock is at or below the low threshold.
- `recommended = ceil(avg × lead_days) + safety_stock − stock`.
- With no data the app shows *"Consumption data needed to calculate stock prediction."* and never a guess.

### Alerts
- Colours: green = ok, yellow = low (default 3), red = critical (default **1**), grey = unconfirmed. Customers
  and suppliers can change the thresholds.
- `customer_stock.alert_level` tracks the current episode. An alert fires only when the level gets worse, and
  the state resets when stock rises above the threshold, so there are no repeated alerts.
- Customers can mute non-critical notifications. Critical alerts always appear in the app.

### Billing
- `amount_due = previous_balance + (confirmed deliveries × price + tax) − payments received − credits`, counting
  payments and credits since the previous invoice. Consumption is never billed.
- The price is snapshotted on each delivery, so a price change applies to new deliveries only. Customer-specific
  prices override the supplier default.
- Idempotency comes from three guards:
  - `unique (customer_id, period_start, period_end)`
  - a unique index on `invoice_items.delivery_id`, so each delivery is billed exactly once
  - a per-supplier advisory lock
- A delivery confirmed late is picked up by the next bill.
- Invoice money columns are immutable (trigger). Corrections use **credit notes**.
- Status is **paid**, **partially paid**, **unpaid** or **overdue**. Due and overdue reminders are deduplicated
  (overdue at most once a week).

### Payments
- Cash, UPI and bank transfers recorded by the supplier count immediately.
- Payments the customer reports stay **pending** until the supplier verifies them.
- **Online payments** are created server-side (`create-payment-order`) and marked successful **only** by
  `payment-webhook` after HMAC-SHA256 signature verification and an amount check. Webhook retries are harmless.

---

## Security model

- **RLS on every table.** Suppliers see only their own business, and customers see only their own accounts.
  Admin access is checked through `is_admin()`.
- **No direct writes** to stock, ledger, deliveries, orders, invoices, payments or notifications from clients.
  Every privileged change is a `SECURITY DEFINER` function that checks `auth.uid()`, ownership, the supplier's
  active status and its inputs.
- **No self-escalation.** Self-signup can only create `customer` or `supplier` profiles. Triggers block role and
  status changes, business-code edits, and invoice-number tampering.
- **Job, outbox and billing functions** are revoked from `anon`/`authenticated`. Only the service role, pg_cron
  and other definer functions can call them.
- The **service-role key** lives only in Edge Function secrets. The browser only ever gets the anon key.
- **Audit log** covering registrations, connections, deliveries, confirmations, adjustments, stock movements,
  orders, invoices, payments, credit notes and admin actions.
- CSV exports neutralise spreadsheet-formula injection. Cloudflare serves security headers (see `public/_headers`).

Customers can connect to a supplier **only** with a supplier code, an invite link or a QR code. Invites can
expire, be revoked and be limited in uses.

---

## Deploying

### 1. Supabase

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push                        # applies supabase/migrations (never seed.sql)
```

Enable the **pg_cron** and **pg_net** extensions (Dashboard → Database → Extensions) *before* `db push`, so
`20261125000007_cron.sql` can schedule:

| Job | Schedule (UTC) | Function |
|---|---|---|
| Auto daily consumption | every 15 min | `process_auto_consumption()` |
| Prediction refresh + alerts | hourly | `refresh_all_predictions()` |
| Monthly invoices | daily 18:50 (00:20 IST) | `run_monthly_billing(...)`, which only bills suppliers whose period just closed |
| Payment due/overdue reminders | daily 03:30 (09:00 IST) | `process_payment_reminders(...)` |
| Email/WhatsApp dispatch | every 2 min | calls the `dispatch-notifications` function |

If you enabled the extensions after pushing, re-run the contents of `20261125000007_cron.sql` in the SQL editor.

Edge Functions and their secrets:

```bash
supabase secrets set RESEND_API_KEY=... EMAIL_FROM="Waterdrop <alerts@yourdomain.com>" \
  CRON_SECRET=$(openssl rand -hex 32) APP_URL=https://waterdrop.<your-subdomain>.workers.dev \
  PAYMENT_GATEWAY_KEY=rzp_live_... PAYMENT_GATEWAY_SECRET=... PAYMENT_GATEWAY_WEBHOOK_SECRET=... \
  WHATSAPP_PROVIDER_API_KEY=... WHATSAPP_PHONE_NUMBER_ID=...      # WhatsApp is optional
supabase functions deploy dispatch-notifications --no-verify-jwt
supabase functions deploy run-scheduled-jobs --no-verify-jwt
supabase functions deploy payment-webhook --no-verify-jwt
supabase functions deploy create-payment-order
```

(`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions automatically.)

So that pg_cron can call the dispatcher, store two Vault secrets (SQL editor):

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1', 'wd_functions_url');
select vault.create_secret('<the same CRON_SECRET>', 'wd_cron_secret');
```

**Auth settings:** set the Site URL to your Cloudflare domain, and add `https://<domain>/reset-password` and
`https://<domain>/home` to the redirect URLs.

**Make yourself platform admin** (admins can't self-register):

```sql
update public.profiles set role = 'admin' where email = 'you@yourdomain.com';
```

**Razorpay:** add a webhook to `https://<project-ref>.supabase.co/functions/v1/payment-webhook` for
`payment.captured`, `order.paid` and `payment.failed`, using `PAYMENT_GATEWAY_WEBHOOK_SECRET`.

**No pg_cron?** Call the job endpoint from any scheduler:

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/run-scheduled-jobs \
  -H "x-cron-secret: $CRON_SECRET" -d '{"jobs":["auto_consumption","predictions","billing","reminders"]}'
```

### 2. Cloudflare

The frontend is a static site served by Cloudflare Workers static assets. `wrangler.jsonc` configures
single-page-app routing, and `public/_headers` sets the security and caching headers. There is no server code
on Cloudflare: the API, auth and database are all Supabase.

**Option A — Git integration (recommended):**
1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick this repo.
2. Build command `npm run build`, deploy command `npx wrangler deploy`.
3. Under **Settings → Build → Variables**, add the *build* variables (Vite bakes them in at build time). Use
   public values only:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - optionally `VITE_PAYMENT_GATEWAY_KEY` (the Razorpay **key id**), which shows the "Pay online" button
4. Every push to the production branch deploys. Other branches get preview URLs.

**Option B — from your machine:**

```bash
npx wrangler login
cp .env.example .env.production.local   # fill the VITE_* values
npm run deploy                          # build + wrangler deploy
```

Your app is then live at `https://waterdrop.<your-subdomain>.workers.dev`. To use your own domain, go to
**Workers → waterdrop → Settings → Domains & Routes → Add custom domain**. Then update the Supabase Site URL,
the redirect URLs and `APP_URL` to match.

`npm run preview:cf` runs the production build locally in Cloudflare's runtime.

---

## Integrations that need API keys

| Integration | Variables | Without it |
|---|---|---|
| Supabase | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`; `SUPABASE_SERVICE_ROLE_KEY` (functions, automatic) | App shows a setup screen |
| Email (Resend) | `RESEND_API_KEY`, `EMAIL_FROM` | In-app notifications still work. Email outbox rows retry, then fail visibly in admin stats |
| WhatsApp (optional) | `WHATSAPP_PROVIDER_API_KEY`, `WHATSAPP_PHONE_NUMBER_ID` | Only queued for users who opted in. Warning/critical alerts only |
| Online payments (Razorpay) | `PAYMENT_GATEWAY_KEY`, `PAYMENT_GATEWAY_SECRET`, `PAYMENT_GATEWAY_WEBHOOK_SECRET`, `VITE_PAYMENT_GATEWAY_KEY` | Cash/UPI/bank payments still work, recorded by the supplier or submitted for verification |
| Schedulers | `CRON_SECRET` | pg_cron SQL jobs still run. Email/WhatsApp dispatch needs it |

Never commit real secrets. `.env*` files are git-ignored except `.env.example`.
