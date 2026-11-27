#!/usr/bin/env python3
"""Generates supabase/migrations/20261127000016_platform_fees.sql.

generate_invoice_for_customer is copied from its latest definition (migration
12) and patched to add one "Waterdrop service fee" line per branch per month.
Every patch must match exactly once.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
M12 = (ROOT / "supabase/migrations/20261126000012_customer_accounts.sql").read_text()


def fn(name: str, src: str = M12) -> str:
    start = src.rindex(f"create or replace function public.{name}(")
    body = src.index(" as $$", start) + len(" as $$")
    end = src.index("$$;", body) + 3
    return src[start:end]


def patch(text: str, pairs) -> str:
    for old, new in pairs:
        assert text.count(old) == 1, f"pattern not found exactly once: {old[:70]!r}"
        text = text.replace(old, new)
    return text


gen = patch(fn("generate_invoice_for_customer"), [
    ("  v_multi boolean;\nbegin",
     "  v_multi boolean;\n  v_fee numeric;\n  v_fee_month date;\nbegin"),
    ("    delivery_id uuid, adjustment_id uuid, item_date date, description text, quantity integer, unit_price numeric, amount numeric\n  ) on commit drop;",
     "    delivery_id uuid, adjustment_id uuid, item_date date, description text, quantity integer, unit_price numeric, amount numeric,\n"
     "    fee_customer_id uuid, fee_month date\n  ) on commit drop;"),
    ("  select d.id, null, d.delivery_date,",
     "  select d.id, null, d.delivery_date,"),
    ("         d.confirmed_quantity, d.unit_price, round(d.confirmed_quantity * d.unit_price, 2)\n",
     "         d.confirmed_quantity, d.unit_price, round(d.confirmed_quantity * d.unit_price, 2), null, null\n"),
    ("         format('Delivery correction: %s', a.reason), a.delta, a.unit_price, round(a.delta * a.unit_price, 2)\n",
     "         format('Delivery correction: %s', a.reason), a.delta, a.unit_price, round(a.delta * a.unit_price, 2), null, null\n"),
    ("  select count(*), coalesce(sum(quantity), 0), coalesce(sum(amount), 0) into v_items, v_qty, v_subtotal from _wd_items;",
     "  -- Waterdrop service fee: one line per branch for the billed month (first month free).\n"
     "  v_fee_month := date_trunc('month', p_period_end)::date;\n"
     "  insert into _wd_items\n"
     "  select null, null, v_fee_month,\n"
     "         case when v_multi then coalesce(b.branch_name, b.customer_name) || ' – ' else '' end ||\n"
     "         'Waterdrop service fee – ' || to_char(v_fee_month, 'Mon YYYY'),\n"
     "         1, f.fee, f.fee, b.id, v_fee_month\n"
     "  from public.customers b\n"
     "  cross join lateral (select public.branch_platform_fee(b.id, v_fee_month) as fee) f\n"
     "  where (b.id = c.id or b.bill_to_customer_id = c.id) and f.fee > 0\n"
     "    and not exists (select 1 from public.invoice_items ii where ii.fee_customer_id = b.id and ii.fee_month = v_fee_month);\n\n"
     "  select count(*), coalesce(sum(quantity) filter (where fee_month is null), 0),\n"
     "         coalesce(sum(amount) filter (where fee_month is null), 0), coalesce(sum(amount) filter (where fee_month is not null), 0)\n"
     "    into v_items, v_qty, v_subtotal, v_fee from _wd_items;"),
    ("  v_due := round(v_prev_balance + v_subtotal + v_tax - v_payments - v_credits, 2);",
     "  v_due := round(v_prev_balance + v_subtotal + v_tax + v_fee - v_payments - v_credits, 2);"),
    ("    payments_received, credits, amount_due, due_date, status, supplier_snapshot, customer_snapshot, generated_at)",
     "    payments_received, credits, amount_due, due_date, status, supplier_snapshot, customer_snapshot, generated_at, platform_fee)"),
    ("    st.tax_rate, v_tax, v_subtotal + v_tax, v_prev_balance, v_payments, v_credits, v_due,",
     "    st.tax_rate, v_tax, v_subtotal + v_tax + v_fee, v_prev_balance, v_payments, v_credits, v_due,"),
    ("                                    from public.customers x where x.id = c.id or x.bill_to_customer_id = c.id)),\n    v_now)",
     "                                    from public.customers x where x.id = c.id or x.bill_to_customer_id = c.id)),\n    v_now, v_fee)"),
    ("  insert into public.invoice_items (invoice_id, delivery_id, delivery_adjustment_id, item_date, description, quantity, unit_price, amount)\n"
     "  select v_inv, delivery_id, adjustment_id, item_date, description, quantity, unit_price, amount\n",
     "  insert into public.invoice_items (invoice_id, delivery_id, delivery_adjustment_id, item_date, description, quantity, unit_price, amount,\n"
     "                                    fee_customer_id, fee_month)\n"
     "  select v_inv, delivery_id, adjustment_id, item_date, description, quantity, unit_price, amount, fee_customer_id, fee_month\n"),
])

out = "\n".join([
    (ROOT / "scripts/migration-16-head.sql").read_text(),
    "-- Customer bills now carry the Waterdrop service fee lines.",
    gen,
    "",
    (ROOT / "scripts/migration-16-tail.sql").read_text(),
])
dest = ROOT / "supabase/migrations/20261127000016_platform_fees.sql"
dest.write_text(out)
print(f"wrote {dest.relative_to(ROOT)} ({len(out)} bytes)")
