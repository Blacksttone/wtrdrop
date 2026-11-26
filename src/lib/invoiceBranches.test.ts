import { describe, expect, it } from "vitest";
import { groupItemsByBranch } from "./invoiceBranches";
import type { InvoiceItem } from "@/types/db";

const item = (description: string, quantity: number, amount: number): InvoiceItem => ({
  id: description, invoice_id: "i", delivery_id: null, delivery_adjustment_id: null, item_date: "2026-11-01",
  description, quantity, unit_price: amount / quantity, amount,
});

describe("groupItemsByBranch", () => {
  it("keeps single bills as one section", () => {
    const s = groupItemsByBranch({ customer_snapshot: { customer_name: "A", address: "x" } }, [item("Delivery", 2, 60)]);
    expect(s).toHaveLength(1);
    expect(s[0].branch).toBeNull();
    expect(s[0].amount).toBe(60);
  });
  it("splits combined bills by branch prefix with subtotals", () => {
    const s = groupItemsByBranch(
      { customer_snapshot: { customer_name: "Co", address: "x", branches: ["Main", "Main 2"] } },
      [item("Main – Delivery 5 cans", 5, 150), item("Main 2 – Delivery 3 cans", 3, 90), item("Main – Delivery 1 can", 1, 30)],
    );
    expect(s.map((x) => [x.branch, x.quantity, x.amount])).toEqual([["Main", 6, 180], ["Main 2", 3, 90]]);
    expect(s[1].items[0].shortDescription).toBe("Delivery 3 cans");
  });
});
