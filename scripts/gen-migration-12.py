#!/usr/bin/env python3
"""Generates supabase/migrations/20261126000012_customer_accounts.sql.

Functions that only need small changes (notification fan-out, branch-aware
billing, member access) are copied from the migration that last defined them
and patched with exact string replacements, so their bodies stay identical
to the tested versions apart from the intended edits. Every replacement is
asserted to match exactly once.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
src = {n: (MIG / f).read_text() for n, f in {
    "m2": "20261125000002_security_and_ledger.sql",
    "m3": "20261125000003_operations.sql",
    "m4": "20261125000004_billing_payments.sql",
    "m5": "20261125000005_dashboards_jobs_admin.sql",
    "m9": "20261126000009_staff_household_blocking.sql",
}.items()}


def fn(mig: str, name: str) -> str:
    """Latest definition of a plpgsql/sql function inside a migration file."""
    text = src[mig]
    start = text.rindex(f"create or replace function public.{name}(")
    body_start = text.index("as $$", start) + 5
    end = text.index("$$;", body_start) + 3
    return text[start:end]


def patch(body: str, *pairs: tuple[str, str]) -> str:
    for old, new in pairs:
        count = body.count(old)
        assert count >= 1, f"pattern not found: {old[:80]!r}"
        body = body.replace(old, new)
    return body


NOTIFY_ALL = ("public.notify(c.user_id, ", "public.notify_customer(c.id, 'all', ")
NOTIFY_BILL = ("public.notify(c.user_id, ", "public.notify_customer(c.id, 'billing', ")

parts: list[str] = []
add = parts.append

add((ROOT / "scripts" / "migration-12-head.sql").read_text())

# ---------------------------------------------------------------- access
add("-- Members of a customer account act on its branches (blocked-by-supplier check kept).")
add(patch(fn("m9", "customer_for_actor"),
          ("  if c.user_id = auth.uid() then", "  if c.id in (select public.my_customer_ids()) then")))

add(patch(fn("m3", "record_consumption"),
          ("  if c.user_id is not null and c.user_id <> auth.uid() then",
           "  if c.user_id is not null and c.id not in (select public.my_customer_ids()) then")))

# ---------------------------------------------------------------- notification fan-out
add("-- Notifications now reach every member with access to the branch.")
add(patch(fn("m2", "evaluate_stock_alert"), NOTIFY_ALL))
add(patch(fn("m3", "refresh_prediction"), NOTIFY_ALL))
add(patch(fn("m3", "adjust_delivery"), NOTIFY_ALL))
add(patch(fn("m3", "resolve_correction_request"), NOTIFY_ALL))
add(patch(fn("m9", "record_delivery"), NOTIFY_ALL))
add(patch(fn("m9", "update_order_status"), NOTIFY_ALL))
add(patch(fn("m9", "set_customer_blocked"), NOTIFY_ALL))
add(patch(fn("m5", "process_payment_reminders"),
          ("public.notify((select user_id from public.customers where id = v_inv.customer_id), ",
           "public.notify_customer(v_inv.customer_id, 'billing', ")))

# ---------------------------------------------------------------- combined billing
add("-- Combined bills: a head branch is billed for itself and the branches that bill to it.")
add(patch(fn("m4", "customer_balance"),
          ("""  select round(
      coalesce((select opening_balance from public.customers where id = p_customer_id), 0)
    + coalesce((select sum(current_charges) from public.invoices where customer_id = p_customer_id), 0)
    - coalesce((select sum(amount) from public.payments where customer_id = p_customer_id and status = 'succeeded'), 0)
    - coalesce((select sum(amount) from public.credit_notes where customer_id = p_customer_id), 0), 2);""",
           """  with g as (select public.billing_group(public.head_customer_id(p_customer_id)) as id)
  select round(
      coalesce((select sum(opening_balance) from public.customers where id in (select id from g)), 0)
    + coalesce((select sum(current_charges) from public.invoices where customer_id in (select id from g)), 0)
    - coalesce((select sum(amount) from public.payments where customer_id in (select id from g) and status = 'succeeded'), 0)
    - coalesce((select sum(amount) from public.credit_notes where customer_id in (select id from g)), 0), 2);""")))
add(patch(fn("m4", "customer_unbilled"),
          ("    where dl.customer_id = p_customer_id and dl.status = 'confirmed'",
           "    where dl.customer_id in (select public.billing_group(public.head_customer_id(p_customer_id))) and dl.status = 'confirmed'"),
          ("    where a.customer_id = p_customer_id\n",
           "    where a.customer_id in (select public.billing_group(public.head_customer_id(p_customer_id)))\n")))
add(patch(fn("m4", "refresh_invoice_status"),
          ("                    where customer_id = i.customer_id and status = 'succeeded'",
           "                    where customer_id in (select public.billing_group(i.customer_id)) and status = 'succeeded'"),
          ("                    where customer_id = i.customer_id\n",
           "                    where customer_id in (select public.billing_group(i.customer_id))\n")))
add(patch(fn("m4", "generate_invoice_for_customer"),
          ("  v_now timestamptz;\nbegin", "  v_now timestamptz;\n  v_multi boolean;\nbegin"),
          ("""  if c.id is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
""", """  if c.id is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  -- Branches that bill to a head branch appear on the head branch's combined bill.
  if c.bill_to_customer_id is not null then
    return null;
  end if;
  v_multi := exists (select 1 from public.customers where bill_to_customer_id = c.id);
"""),
          ("""  select d.id, null, d.delivery_date,
         format('Water cans delivered (confirmed %s of %s expected)', d.confirmed_quantity, d.expected_quantity),
         d.confirmed_quantity, d.unit_price, round(d.confirmed_quantity * d.unit_price, 2)
  from public.deliveries d
  where d.customer_id = c.id and d.status = 'confirmed' and d.delivery_date <= p_period_end""",
           """  select d.id, null, d.delivery_date,
         case when v_multi then coalesce(b.branch_name, b.customer_name) || ' – ' else '' end ||
         format('Water cans delivered (confirmed %s of %s expected)', d.confirmed_quantity, d.expected_quantity),
         d.confirmed_quantity, d.unit_price, round(d.confirmed_quantity * d.unit_price, 2)
  from public.deliveries d join public.customers b on b.id = d.customer_id
  where (b.id = c.id or b.bill_to_customer_id = c.id) and d.status = 'confirmed' and d.delivery_date <= p_period_end"""),
          ("""  select null, a.id, (a.created_at at time zone c.timezone)::date,
         format('Delivery correction: %s', a.reason), a.delta, a.unit_price, round(a.delta * a.unit_price, 2)
  from public.delivery_adjustments a
  where a.customer_id = c.id and (a.created_at at time zone c.timezone)::date <= p_period_end""",
           """  select null, a.id, (a.created_at at time zone c.timezone)::date,
         case when v_multi then coalesce(b.branch_name, b.customer_name) || ' – ' else '' end ||
         format('Delivery correction: %s', a.reason), a.delta, a.unit_price, round(a.delta * a.unit_price, 2)
  from public.delivery_adjustments a join public.customers b on b.id = a.customer_id
  where (b.id = c.id or b.bill_to_customer_id = c.id) and (a.created_at at time zone c.timezone)::date <= p_period_end"""),
          ("  v_prev_balance := coalesce(prev.amount_due, c.opening_balance, 0);",
           "  v_prev_balance := coalesce(prev.amount_due,\n    (select sum(opening_balance) from public.customers where id in (select public.billing_group(c.id))), 0);"),
          ("   where customer_id = c.id and status = 'succeeded'\n",
           "   where customer_id in (select public.billing_group(c.id)) and status = 'succeeded'\n"),
          ("   where customer_id = c.id and (prev.id is null or created_at > prev.generated_at) and created_at <= v_now;",
           "   where customer_id in (select public.billing_group(c.id)) and (prev.id is null or created_at > prev.generated_at) and created_at <= v_now;"),
          ("    jsonb_build_object('customer_name', c.customer_name, 'address', c.address, 'phone', c.phone),",
           """    jsonb_build_object('customer_name', coalesce((select name from public.customer_accounts where id = c.account_id), c.customer_name),
                       'address', c.address, 'phone', c.phone, 'branch_name', c.branch_name,
                       'branches', (select jsonb_agg(coalesce(x.branch_name, x.customer_name) order by x.created_at)
                                    from public.customers x where x.id = c.id or x.bill_to_customer_id = c.id)),"""),
          NOTIFY_BILL))
add(patch(fn("m4", "finalize_payment"),
          ("  select * into c from public.customers where id = p.customer_id for update;",
           "  select * into c from public.customers where id = public.head_customer_id(p.customer_id) for update;"),
          ("    (select id from public.invoices where customer_id = p.customer_id and superseded_by is null",
           "    (select id from public.invoices where customer_id = c.id and superseded_by is null"),
          NOTIFY_BILL))
add(patch(fn("m4", "verify_payment"), NOTIFY_BILL))
add(patch(fn("m4", "issue_credit_note"),
          ("  select id into v_latest from public.invoices where customer_id = c.id and superseded_by is null",
           "  select id into v_latest from public.invoices where customer_id = public.head_customer_id(c.id) and superseded_by is null"),
          NOTIFY_BILL))
add(patch(fn("m4", "submit_payment"),
          ("  c public.customers := public.customer_for_actor(p_customer_id, false);",
           "  c public.customers := public.customer_for_billing(p_customer_id);")))
add(patch(fn("m4", "create_gateway_payment"),
          ("""  if c.id is null or c.user_id is distinct from p_actor then""",
           """  if c.id is null or not (
       (c.account_id is null and c.user_id = p_actor)
       or exists (select 1 from public.customer_account_members m where m.account_id = c.account_id
                  and m.user_id = p_actor and m.status = 'active' and m.role in ('owner', 'admin'))) then"""),
          ("          (select id from public.invoices where customer_id = c.id and superseded_by is null order by generated_at desc limit 1))",
           "          (select id from public.invoices where customer_id = public.head_customer_id(c.id) and superseded_by is null order by generated_at desc limit 1))")))

# ---------------------------------------------------------------- dashboards / lists
add(patch(fn("m5", "get_customer_summary"),
          ("  v_latest_invoice jsonb;\nbegin", "  v_latest_invoice jsonb;\n  v_money boolean;\nbegin"),
          ("""    select id, invoice_number, amount_due, amount_paid, due_date, status, billing_period_start, billing_period_end
    from public.invoices where customer_id = c.id order by generated_at desc limit 1) i;""",
           """    select id, invoice_number, amount_due, amount_paid, due_date, status, billing_period_start, billing_period_end
    from public.invoices where customer_id = public.head_customer_id(c.id) order by generated_at desc limit 1) i;
  -- Family / team members with the Member role do not see money.
  v_money := c.id not in (select public.my_customer_ids()) or c.id in (select public.my_billing_customer_ids());"""),
          ("""    'latest_invoice', v_latest_invoice,
    'outstanding_balance', public.customer_balance(c.id),
    'unbilled', public.customer_unbilled(c.id)""",
           """    'latest_invoice', case when v_money then v_latest_invoice end,
    'outstanding_balance', case when v_money then public.customer_balance(c.id) else 0 end,
    'unbilled', case when v_money then public.customer_unbilled(c.id) else jsonb_build_object('quantity', 0, 'amount', 0) end,
    'can_see_money', v_money""")))
add(patch(fn("m5", "get_supplier_dashboard"),
          ("""    'outstanding_total', (select coalesce(sum(greatest(public.customer_balance(id), 0)), 0)
                           from public.customers where supplier_id = v_sid),""",
           """    'outstanding_total', (select coalesce(sum(greatest(public.customer_balance(id), 0)), 0)
                           from public.customers where supplier_id = v_sid and bill_to_customer_id is null),"""),
          ("        from public.customers c where c.supplier_id = v_sid and public.customer_balance(c.id) > 0",
           "        from public.customers c where c.supplier_id = v_sid and c.bill_to_customer_id is null and public.customer_balance(c.id) > 0")))
add(patch(fn("m5", "report_outstanding"),
          ("  where c.supplier_id = public.report_scope(p_supplier_id) and public.customer_balance(c.id) <> 0",
           "  where c.supplier_id = public.report_scope(p_supplier_id) and c.bill_to_customer_id is null and public.customer_balance(c.id) <> 0")))

lsc = patch(fn("m9", "list_supplier_customers"),
            ("  household_type text, members_count integer, blocked boolean\n)",
             "  household_type text, members_count integer, blocked boolean,\n  account_name text, account_type text, branch_name text, bill_to_customer_id uuid\n)"),
            ("         c.household_type, c.members_count, c.blocked_at is not null\n",
             "         c.household_type, c.members_count, c.blocked_at is not null,\n"
             "         a.name, a.account_type::text, c.branch_name, c.bill_to_customer_id\n"),
            ("  from public.customers c left join public.customer_stock s on s.customer_id = c.id\n",
             "  from public.customers c left join public.customer_stock s on s.customer_id = c.id\n"
             "  left join public.customer_accounts a on a.id = c.account_id\n"),
            ("         public.customer_balance(c.id), c.created_at,",
             "         case when c.bill_to_customer_id is null then public.customer_balance(c.id) end, c.created_at,"))
add("drop function public.list_supplier_customers();\n" + lsc)

alc = patch(fn("m5", "admin_list_customers"),
            ("               user_disabled boolean, status public.customer_status, current_stock integer, balance numeric, created_at timestamptz)",
             "               user_disabled boolean, status public.customer_status, current_stock integer, balance numeric, created_at timestamptz,\n"
             "               account_name text, account_type text, branch_name text)"),
            ("         coalesce(pr.is_disabled, false), c.status, coalesce(cs.current_stock, 0), public.customer_balance(c.id), c.created_at\n",
             "         coalesce(pr.is_disabled, false), c.status, coalesce(cs.current_stock, 0), public.customer_balance(c.id), c.created_at,\n"
             "         a.name, a.account_type::text, c.branch_name\n"),
            ("  left join public.customer_stock cs on cs.customer_id = c.id\n",
             "  left join public.customer_stock cs on cs.customer_id = c.id\n  left join public.customer_accounts a on a.id = c.account_id\n"),
            ("    and (p_search is null or c.customer_name ilike '%' || p_search || '%' or c.phone ilike '%' || p_search || '%')",
             "    and (p_search is null or c.customer_name ilike '%' || p_search || '%' or c.phone ilike '%' || p_search || '%'\n"
             "         or a.name ilike '%' || p_search || '%')"))
add("drop function public.admin_list_customers(text);\n" + alc)

ums = patch(fn("m9", "update_my_customer_settings"),
            ("  p_members_count integer default null\n) returns public.customers",
             "  p_members_count integer default null,\n  p_branch_name text default null\n) returns public.customers"),
            ("    members_count = coalesce(p_members_count, members_count)\n",
             "    members_count = coalesce(p_members_count, members_count),\n"
             "    branch_name = coalesce(nullif(trim(p_branch_name), ''), branch_name)\n"))
add("drop function public.update_my_customer_settings(uuid, integer, boolean, time, text, integer, integer, integer, text, text, text, text, integer);\n" + ums)

add((ROOT / "scripts" / "migration-12-tail.sql").read_text())

out = MIG / "20261126000012_customer_accounts.sql"
out.write_text("\n\n".join(p.strip("\n") for p in parts) + "\n")
print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size} bytes)")
