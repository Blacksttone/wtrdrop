-- =====================================================================
-- Waterdrop — core schema
-- Tables, enums, constraints and indexes.
-- All quantities are whole water cans (integers). Money is numeric(12,2).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.app_role as enum ('admin', 'supplier', 'customer');
create type public.supplier_status as enum ('active', 'suspended');
create type public.customer_status as enum ('active', 'inactive');
create type public.inventory_txn_type as enum (
  'opening_stock', 'delivery_received', 'consumption', 'return', 'damage', 'adjustment', 'stockout'
);
create type public.delivery_status as enum ('awaiting_confirmation', 'confirmed', 'cancelled');
create type public.consumption_source as enum ('manual', 'auto', 'correction');
create type public.order_status as enum (
  'pending', 'accepted', 'preparing', 'out_for_delivery', 'delivered', 'cancelled', 'rejected'
);
create type public.invoice_status as enum ('unpaid', 'partially_paid', 'paid', 'overdue');
create type public.payment_method as enum ('cash', 'upi', 'bank_transfer', 'online');
create type public.payment_status as enum ('pending', 'succeeded', 'failed', 'refunded');
create type public.stock_alert_level as enum ('none', 'low', 'critical');
create type public.correction_status as enum ('pending', 'approved', 'rejected');

-- ---------------------------------------------------------------------
-- Generic updated_at trigger
-- ---------------------------------------------------------------------
create or replace function public.tg_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 120),
  phone text check (phone is null or phone ~ '^\+?[0-9 ]{7,16}$'),
  email text check (email is null or char_length(email) <= 254),
  role public.app_role not null default 'customer',
  notification_preferences jsonb not null default
    '{"email": true, "whatsapp": false, "noncritical": true}'::jsonb,
  is_disabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_role_idx on public.profiles (role);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- Subscription plans (platform → supplier)
-- ---------------------------------------------------------------------
create table public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 2 and 60),
  price_monthly numeric(12,2) not null default 0 check (price_monthly >= 0),
  max_customers integer check (max_customers is null or max_customers > 0),
  features jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles (id) on delete restrict,
  business_name text not null check (char_length(business_name) between 2 and 120),
  business_code text not null unique check (business_code ~ '^[A-Z0-9]{6,10}$'),
  owner_name text not null check (char_length(owner_name) between 2 and 120),
  phone text not null check (phone ~ '^\+?[0-9 ]{7,16}$'),
  email text check (email is null or char_length(email) <= 254),
  address text not null check (char_length(address) between 3 and 500),
  delivery_area text check (delivery_area is null or char_length(delivery_area) <= 300),
  logo_url text check (logo_url is null or char_length(logo_url) <= 1000),
  billing_info jsonb not null default '{}'::jsonb,
  status public.supplier_status not null default 'active',
  plan_id uuid references public.subscription_plans (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger suppliers_updated_at before update on public.suppliers
  for each row execute function public.tg_set_updated_at();

create table public.supplier_settings (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null unique references public.suppliers (id) on delete cascade,
  default_can_price numeric(12,2) not null default 40 check (default_can_price >= 0 and default_can_price <= 100000),
  delivery_lead_days integer not null default 1 check (delivery_lead_days between 0 and 30),
  billing_day integer not null default 1 check (billing_day between 1 and 28),
  billing_due_days integer not null default 10 check (billing_due_days between 0 and 90),
  tax_rate numeric(5,2) not null default 0 check (tax_rate >= 0 and tax_rate <= 50),
  tax_label text not null default 'GST' check (char_length(tax_label) <= 20),
  invoice_prefix text not null default 'WD' check (invoice_prefix ~ '^[A-Z0-9]{1,8}$'),
  invoice_seq integer not null default 0 check (invoice_seq >= 0),
  bulk_order_threshold integer not null default 10 check (bulk_order_threshold between 2 and 10000),
  default_low_stock_threshold integer not null default 3 check (default_low_stock_threshold between 0 and 1000),
  default_critical_threshold integer not null default 1 check (default_critical_threshold between 0 and 1000),
  default_safety_stock integer not null default 2 check (default_safety_stock between 0 and 1000),
  notification_settings jsonb not null default
    '{"notify_new_orders": true, "notify_shortages": true, "notify_critical_customers": true}'::jsonb,
  updated_at timestamptz not null default now()
);
create trigger supplier_settings_updated_at before update on public.supplier_settings
  for each row execute function public.tg_set_updated_at();

-- Invitation links / QR codes generated by suppliers
create table public.supplier_invites (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers (id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(16), 'hex'),
  label text check (label is null or char_length(label) <= 80),
  max_uses integer check (max_uses is null or max_uses > 0),
  uses integer not null default 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index supplier_invites_supplier_idx on public.supplier_invites (supplier_id);

-- ---------------------------------------------------------------------
-- Customers (a customer account at a specific supplier)
-- user_id is null for "offline" customers managed by the supplier only.
-- ---------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete set null,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  customer_name text not null check (char_length(customer_name) between 2 and 120),
  phone text check (phone is null or phone ~ '^\+?[0-9 ]{7,16}$'),
  address text not null check (char_length(address) between 3 and 500),
  delivery_instructions text check (delivery_instructions is null or char_length(delivery_instructions) <= 500),
  can_price numeric(12,2) check (can_price is null or (can_price >= 0 and can_price <= 100000)),
  daily_consumption integer not null default 0 check (daily_consumption between 0 and 1000),
  auto_consumption_enabled boolean not null default false,
  auto_consumption_time time not null default '21:00',
  auto_consumption_since date,
  timezone text not null default 'Asia/Kolkata',
  low_stock_threshold integer not null default 3 check (low_stock_threshold between 0 and 1000),
  critical_threshold integer not null default 1 check (critical_threshold between 0 and 1000),
  safety_stock integer not null default 2 check (safety_stock between 0 and 1000),
  opening_balance numeric(12,2) not null default 0,
  status public.customer_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_thresholds_ck check (critical_threshold <= low_stock_threshold)
);
create unique index customers_user_supplier_uq on public.customers (user_id, supplier_id) where user_id is not null;
create index customers_supplier_idx on public.customers (supplier_id, status);
create index customers_user_idx on public.customers (user_id);
create trigger customers_updated_at before update on public.customers
  for each row execute function public.tg_set_updated_at();

-- Cached balance derived from the inventory ledger (maintained by trigger only)
create table public.customer_stock (
  customer_id uuid primary key references public.customers (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete cascade,
  current_stock integer not null default 0 check (current_stock >= 0),
  has_opening_stock boolean not null default false,
  alert_level public.stock_alert_level not null default 'none',
  last_alert_at timestamptz,
  avg_daily_consumption numeric(10,2),
  predicted_empty_date date,
  order_recommended boolean not null default false,
  order_alert_sent boolean not null default false,
  prediction_refreshed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index customer_stock_supplier_idx on public.customer_stock (supplier_id, alert_level);

-- ---------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  customer_id uuid not null references public.customers (id) on delete restrict,
  quantity integer not null check (quantity between 1 and 1000),
  is_bulk boolean not null default false,
  requested_delivery_date date,
  scheduled_date date,
  status public.order_status not null default 'pending',
  delivery_instructions text check (delivery_instructions is null or char_length(delivery_instructions) <= 500),
  status_reason text check (status_reason is null or char_length(status_reason) <= 500),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_supplier_status_idx on public.orders (supplier_id, status, created_at desc);
create index orders_customer_idx on public.orders (customer_id, created_at desc);
create trigger orders_updated_at before update on public.orders
  for each row execute function public.tg_set_updated_at();

create table public.order_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  from_status public.order_status,
  to_status public.order_status not null,
  changed_by uuid references public.profiles (id),
  reason text,
  created_at timestamptz not null default now()
);
create index order_status_history_order_idx on public.order_status_history (order_id, created_at);

-- ---------------------------------------------------------------------
-- Deliveries — supplier-entered; only customer-confirmed qty moves stock
-- ---------------------------------------------------------------------
create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  customer_id uuid not null references public.customers (id) on delete restrict,
  order_id uuid references public.orders (id) on delete set null,
  expected_quantity integer not null check (expected_quantity between 0 and 1000),
  actual_quantity integer not null check (actual_quantity between 0 and 1000),
  confirmed_quantity integer check (confirmed_quantity is null or confirmed_quantity between 0 and 1000),
  adjusted_quantity integer not null default 0,
  unit_price numeric(12,2) not null check (unit_price >= 0),
  delivery_date date not null,
  status public.delivery_status not null default 'awaiting_confirmation',
  notes text check (notes is null or char_length(notes) <= 500),
  customer_note text check (customer_note is null or char_length(customer_note) <= 500),
  confirmed_at timestamptz,
  confirmed_by uuid references public.profiles (id),
  confirmed_by_supplier boolean not null default false,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- shortage (<0) / excess (>0) of what the customer actually received vs. the expected quantity
  discrepancy integer generated always as (confirmed_quantity - expected_quantity) stored,
  -- difference between what the supplier claimed delivered and what the customer confirmed
  claim_gap integer generated always as (confirmed_quantity - actual_quantity) stored,
  constraint deliveries_confirm_ck check (
    (status = 'confirmed' and confirmed_quantity is not null and confirmed_at is not null)
    or (status <> 'confirmed' and confirmed_quantity is null)
  )
);
create index deliveries_supplier_date_idx on public.deliveries (supplier_id, delivery_date desc);
create index deliveries_customer_date_idx on public.deliveries (customer_id, delivery_date desc);
create index deliveries_status_idx on public.deliveries (supplier_id, status);
create unique index deliveries_order_uq on public.deliveries (order_id)
  where order_id is not null and status <> 'cancelled';
create trigger deliveries_updated_at before update on public.deliveries
  for each row execute function public.tg_set_updated_at();

-- Corrections to confirmed deliveries never overwrite: they are recorded here
create table public.delivery_adjustments (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries (id) on delete restrict,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  customer_id uuid not null references public.customers (id) on delete restrict,
  previous_quantity integer not null,
  new_quantity integer not null check (new_quantity between 0 and 1000),
  delta integer generated always as (new_quantity - previous_quantity) stored,
  unit_price numeric(12,2) not null,
  reason text not null check (char_length(reason) between 3 and 500),
  adjusted_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint delivery_adjustments_nonzero_ck check (new_quantity <> previous_quantity)
);
create index delivery_adjustments_delivery_idx on public.delivery_adjustments (delivery_id);
create index delivery_adjustments_customer_idx on public.delivery_adjustments (customer_id, created_at);

-- ---------------------------------------------------------------------
-- Inventory ledger — append-only, source of truth for stock
-- quantity is signed: + increases stock, − decreases stock.
-- ---------------------------------------------------------------------
create table public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  customer_id uuid not null references public.customers (id) on delete restrict,
  transaction_type public.inventory_txn_type not null,
  quantity integer not null check (quantity between -1000 and 1000),
  balance_after integer,
  reference_type text check (reference_type in ('delivery', 'delivery_adjustment', 'consumption', 'manual', 'correction_request')),
  reference_id uuid,
  transaction_date date not null default current_date,
  idempotency_key text unique,
  created_by uuid references public.profiles (id),
  notes text check (notes is null or char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  constraint inventory_sign_ck check (
    case transaction_type
      when 'opening_stock' then quantity >= 0
      when 'delivery_received' then quantity >= 0
      when 'consumption' then quantity <= 0
      when 'return' then quantity <= 0
      when 'damage' then quantity <= 0
      when 'stockout' then quantity = 0
      else true
    end
  )
);
create index inventory_customer_idx on public.inventory_transactions (customer_id, created_at);
create index inventory_supplier_idx on public.inventory_transactions (supplier_id, transaction_date);

-- ---------------------------------------------------------------------
-- Daily consumption — one row per customer per local date
-- ---------------------------------------------------------------------
create table public.consumption_records (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete restrict,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  consumption_date date not null,
  quantity integer not null check (quantity between 0 and 1000),
  unmet_quantity integer not null default 0 check (unmet_quantity >= 0),
  source public.consumption_source not null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint consumption_one_per_day_uq unique (customer_id, consumption_date)
);
create index consumption_customer_date_idx on public.consumption_records (customer_id, consumption_date desc);
create trigger consumption_updated_at before update on public.consumption_records
  for each row execute function public.tg_set_updated_at();

-- Customer requests to correct older consumption entries (supplier approves)
create table public.stock_correction_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete cascade,
  consumption_date date not null,
  current_quantity integer not null,
  requested_quantity integer not null check (requested_quantity between 0 and 1000),
  reason text not null check (char_length(reason) between 3 and 500),
  status public.correction_status not null default 'pending',
  requested_by uuid references public.profiles (id),
  resolved_by uuid references public.profiles (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index correction_pending_uq on public.stock_correction_requests (customer_id, consumption_date)
  where status = 'pending';

-- ---------------------------------------------------------------------
-- Billing
-- ---------------------------------------------------------------------
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  customer_id uuid not null references public.customers (id) on delete restrict,
  invoice_number text not null unique,
  invoice_date date not null,
  billing_period_start date not null,
  billing_period_end date not null,
  total_quantity integer not null default 0,
  subtotal numeric(12,2) not null default 0,
  tax_rate numeric(5,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  current_charges numeric(12,2) not null default 0,
  previous_balance numeric(12,2) not null default 0,
  payments_received numeric(12,2) not null default 0,
  credits numeric(12,2) not null default 0,
  amount_due numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  due_date date not null,
  status public.invoice_status not null default 'unpaid',
  supplier_snapshot jsonb not null default '{}'::jsonb,
  customer_snapshot jsonb not null default '{}'::jsonb,
  superseded_by uuid references public.invoices (id),
  generated_at timestamptz not null default clock_timestamp(),
  notified_at timestamptz,
  constraint invoices_period_ck check (billing_period_end >= billing_period_start),
  -- Idempotency: exactly one invoice per customer per billing period
  constraint invoices_customer_period_uq unique (customer_id, billing_period_start, billing_period_end)
);
create index invoices_supplier_idx on public.invoices (supplier_id, invoice_date desc);
create index invoices_customer_idx on public.invoices (customer_id, generated_at desc);
create index invoices_status_idx on public.invoices (supplier_id, status);

create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete restrict,
  delivery_id uuid references public.deliveries (id) on delete restrict,
  delivery_adjustment_id uuid references public.delivery_adjustments (id) on delete restrict,
  item_date date not null,
  description text not null,
  quantity integer not null,
  unit_price numeric(12,2) not null,
  amount numeric(12,2) not null,
  constraint invoice_items_source_ck check (num_nonnulls(delivery_id, delivery_adjustment_id) = 1)
);
-- A delivery / adjustment can be billed only once, ever.
create unique index invoice_items_delivery_uq on public.invoice_items (delivery_id) where delivery_id is not null;
create unique index invoice_items_adjustment_uq on public.invoice_items (delivery_adjustment_id) where delivery_adjustment_id is not null;
create index invoice_items_invoice_idx on public.invoice_items (invoice_id);

-- Credit notes / adjustments instead of editing finalized invoices
create table public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  customer_id uuid not null references public.customers (id) on delete restrict,
  invoice_id uuid references public.invoices (id) on delete restrict,
  credit_number text not null unique,
  amount numeric(12,2) not null check (amount > 0 and amount <= 10000000),
  reason text not null check (char_length(reason) between 3 and 500),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default clock_timestamp()
);
create index credit_notes_customer_idx on public.credit_notes (customer_id, created_at);

-- ---------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  customer_id uuid not null references public.customers (id) on delete restrict,
  invoice_id uuid references public.invoices (id) on delete set null,
  amount numeric(12,2) not null check (amount > 0 and amount <= 10000000),
  payment_method public.payment_method not null,
  reference_number text check (reference_number is null or char_length(reference_number) <= 100),
  payment_date date not null default current_date,
  status public.payment_status not null default 'pending',
  submitted_by_customer boolean not null default false,
  gateway text,
  gateway_order_id text unique,
  gateway_payment_id text unique,
  notes text check (notes is null or char_length(notes) <= 500),
  recorded_by uuid references public.profiles (id),
  verified_by uuid references public.profiles (id),
  verified_at timestamptz,
  -- moment the money counted towards the account (used for billing windows)
  received_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now(),
  constraint payments_received_ck check ((status = 'succeeded') = (received_at is not null))
);
create index payments_customer_idx on public.payments (customer_id, created_at desc);
create index payments_supplier_idx on public.payments (supplier_id, payment_date desc);
create index payments_invoice_idx on public.payments (invoice_id);
create trigger payments_updated_at before update on public.payments
  for each row execute function public.tg_set_updated_at();

create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  constraint payment_allocations_uq unique (payment_id, invoice_id)
);

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  notification_type text not null check (notification_type in (
    'low_stock', 'critical_stock', 'order_recommended', 'new_order', 'order_accepted', 'order_status',
    'delivery_scheduled', 'delivery_confirmation_required', 'delivery_confirmed', 'delivery_shortage',
    'bill_generated', 'payment_due', 'payment_overdue', 'payment_received', 'payment_submitted',
    'correction_request', 'account', 'system'
  )),
  severity text not null default 'info' check (severity in ('info', 'success', 'warning', 'critical')),
  title text not null check (char_length(title) <= 160),
  message text not null check (char_length(message) <= 1000),
  link text check (link is null or char_length(link) <= 300),
  data jsonb not null default '{}'::jsonb,
  dedupe_key text unique,
  read_at timestamptz,
  email_status text not null default 'skipped' check (email_status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  whatsapp_status text not null default 'skipped' check (whatsapp_status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  delivery_attempts integer not null default 0,
  last_delivery_error text,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;
create index notifications_outbox_idx on public.notifications (created_at)
  where email_status = 'pending' or whatsapp_status = 'pending';

-- ---------------------------------------------------------------------
-- Audit log & scheduled job runs
-- ---------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles (id) on delete set null,
  supplier_id uuid references public.suppliers (id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_supplier_idx on public.audit_logs (supplier_id, created_at desc);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

create table public.job_runs (
  id bigint generated always as identity primary key,
  job_name text not null,
  run_key text not null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  details jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint job_runs_uq unique (job_name, run_key)
);
create index job_runs_started_idx on public.job_runs (started_at desc);
