import type { Invoice, InvoiceItem } from "@/types/db";

export interface BranchSection {
  branch: string | null;
  items: (InvoiceItem & { shortDescription: string })[];
  quantity: number;
  amount: number;
}

/**
 * Splits a combined bill's items into per-branch sections. Combined bills
 * prefix each item description with "Branch – "; single bills return one
 * section with branch = null.
 */
export function groupItemsByBranch(invoice: Pick<Invoice, "customer_snapshot">, items: InvoiceItem[]): BranchSection[] {
  const branches = invoice.customer_snapshot.branches ?? [];
  if (branches.length < 2) {
    return [{ branch: null, items: items.map((it) => ({ ...it, shortDescription: it.description })), ...totals(items) }];
  }
  const sorted = [...branches].sort((a, b) => b.length - a.length); // longest first so "Main" doesn't match "Main 2"
  const map = new Map<string, BranchSection["items"]>(branches.map((b) => [b, []]));
  const other: BranchSection["items"] = [];
  for (const it of items) {
    const b = sorted.find((name) => it.description.startsWith(`${name} – `));
    if (b) map.get(b)!.push({ ...it, shortDescription: it.description.slice(b.length + 3) });
    else other.push({ ...it, shortDescription: it.description });
  }
  const sections = branches.map((b) => ({ branch: b, items: map.get(b)!, ...totals(map.get(b)!) })).filter((s) => s.items.length);
  if (other.length) sections.push({ branch: "Other", items: other, ...totals(other) });
  return sections;
}

function totals(items: InvoiceItem[]) {
  return {
    quantity: items.reduce((s, it) => s + Number(it.quantity), 0),
    amount: Math.round(items.reduce((s, it) => s + Number(it.amount), 0) * 100) / 100,
  };
}
