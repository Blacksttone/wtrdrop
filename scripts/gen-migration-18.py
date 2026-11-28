#!/usr/bin/env python3
"""Generates supabase/migrations/20261128000018_stock_check_and_map.sql.
list_supplier_customers (migration 14) and get_supplier_dashboard (migration 12)
are copied from their latest definitions and patched. Every patch must match once."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
M = lambda n: (ROOT / "supabase/migrations" / n).read_text()


def fn(name, src):
    start = src.rindex(f"create or replace function public.{name}(")
    body = src.index(" as $$", start) + len(" as $$")
    return src[start:src.index("$$;", body) + 3]


def patch(text, pairs):
    for old, new in pairs:
        assert text.count(old) == 1, f"pattern not found exactly once: {old[:70]!r}"
        text = text.replace(old, new)
    return text


lst = patch(fn("list_supplier_customers", M("20261127000014_empty_cans.sql")), [
    ("bill_to_customer_id uuid, cans_out integer\n)",
     "bill_to_customer_id uuid, cans_out integer,\n  latitude double precision, longitude double precision, last_stock_check_at timestamptz\n)"),
    ("c.bill_to_customer_id, public.cans_out(c.id)\n",
     "c.bill_to_customer_id, public.cans_out(c.id),\n         c.latitude, c.longitude, c.last_stock_check_at\n"),
])
dash = patch(fn("get_supplier_dashboard", M("20261126000012_customer_accounts.sql")), [
    ("'needs_delivery_today', coalesce((select jsonb_agg(x order by x->>'date') from (",
     "'needs_delivery_today', coalesce((select jsonb_agg(x order by x->>'date' nulls first, x->>'created_at') from ("),
    ("                                  'date', coalesce(o.scheduled_date, o.requested_delivery_date)) as x",
     "                                  'date', coalesce(o.scheduled_date, o.requested_delivery_date), 'created_at', o.created_at) as x"),
    ("          and coalesce(o.scheduled_date, o.requested_delivery_date, v_today) <= v_today\n        limit 50) t)",
     "          and coalesce(o.scheduled_date, o.requested_delivery_date, v_today) <= v_today\n"
     "        order by coalesce(o.scheduled_date, o.requested_delivery_date, v_today), o.created_at  -- first come, first served\n"
     "        limit 50) t)"),
])
out = "\n".join([(ROOT / "scripts/migration-18-head.sql").read_text(),
                 "drop function public.list_supplier_customers();", lst, "", dash, "",
                 (ROOT / "scripts/migration-18-tail.sql").read_text()])
dest = ROOT / "supabase/migrations/20261128000018_stock_check_and_map.sql"
dest.write_text(out)
print(f"wrote {dest.relative_to(ROOT)} ({len(out)} bytes)")
