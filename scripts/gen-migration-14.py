#!/usr/bin/env python3
"""Generates supabase/migrations/20261127000014_empty_cans.sql.

record_delivery and list_supplier_customers are copied from their latest
definition (migration 12) and patched, so their bodies stay identical apart
from the empty-can changes. Every patch must match exactly once.
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


record_delivery = patch(fn("record_delivery"), [
    ("  p_notes text default null\n) returns public.deliveries",
     "  p_notes text default null,\n  p_empty_cans integer default 0\n) returns public.deliveries"),
    ("    raise exception 'Quantities must be between 0 and 1000' using errcode = '22023';\n  end if;",
     "    raise exception 'Quantities must be between 0 and 1000' using errcode = '22023';\n  end if;\n"
     "  if coalesce(p_empty_cans, 0) not between 0 and 1000 then\n"
     "    raise exception 'Empty cans must be between 0 and 1000' using errcode = '22023';\n  end if;"),
    ("                                 delivery_date, notes, created_by)",
     "                                 delivery_date, notes, created_by, empty_cans_collected)"),
    ("          v_date, nullif(trim(coalesce(p_notes, '')), ''), auth.uid())",
     "          v_date, nullif(trim(coalesce(p_notes, '')), ''), auth.uid(), coalesce(p_empty_cans, 0))"),
    ("    jsonb_build_object('expected', p_expected_quantity, 'actual', p_actual_quantity));",
     "    jsonb_build_object('expected', p_expected_quantity, 'actual', p_actual_quantity, 'empty_cans', coalesce(p_empty_cans, 0)));"),
])

list_customers = patch(fn("list_supplier_customers"), [
    ("  account_name text, account_type text, branch_name text, bill_to_customer_id uuid\n)",
     "  account_name text, account_type text, branch_name text, bill_to_customer_id uuid, cans_out integer\n)"),
    ("         a.name, a.account_type::text, c.branch_name, c.bill_to_customer_id\n",
     "         a.name, a.account_type::text, c.branch_name, c.bill_to_customer_id, public.cans_out(c.id)\n"),
])

head = (ROOT / "scripts/migration-14-head.sql").read_text()
out = "\n".join([
    head,
    "-- record_delivery gains p_empty_cans (older apps omit it: 0).",
    "drop function public.record_delivery(uuid, integer, integer, date, uuid, text);",
    record_delivery,
    "",
    "drop function public.list_supplier_customers();",
    list_customers,
    "",
    (ROOT / "scripts/migration-14-tail.sql").read_text(),
])
dest = ROOT / "supabase/migrations/20261127000014_empty_cans.sql"
dest.write_text(out)
print(f"wrote {dest.relative_to(ROOT)} ({len(out)} bytes)")
