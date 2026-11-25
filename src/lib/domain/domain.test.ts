import { describe, expect, it } from "vitest";
import { billingPeriodFor, calculateInvoice, invoiceStatus } from "./billing";
import { canCustomerCancel, canRecordDelivery, canTransition, isBulkOrder } from "./orders";
import { computePrediction, daysOfWater } from "./prediction";
import {
  applyConsumption,
  confirmDelivery,
  currentStock,
  NegativeStockError,
  replayLedger,
  stockLevel,
  type LedgerEntry,
} from "./stock";

describe("stock calculation — specification scenario", () => {
  it("opening 5, expected 10, actual 8, confirmed 8, 2/day → 13, 11, 9", () => {
    const delivery = confirmDelivery(10, 8, 8);
    const ledger: LedgerEntry[] = [
      { type: "opening_stock", quantity: 5 },
      { type: "delivery_received", quantity: delivery.stockDelta },
    ];
    expect(currentStock(ledger)).toBe(13);
    ledger.push({ type: "consumption", quantity: -2 });
    expect(currentStock(ledger)).toBe(11);
    ledger.push({ type: "consumption", quantity: -2 });
    expect(currentStock(ledger)).toBe(9);
    expect(delivery.discrepancy).toBe(-2);
  });

  it("customer confirming only 7 of 10 gives stock 12", () => {
    const d = confirmDelivery(10, 10, 7);
    expect(currentStock([{ type: "opening_stock", quantity: 5 }, { type: "delivery_received", quantity: d.stockDelta }])).toBe(12);
    expect(d.claimGap).toBe(-3);
    expect(d.isShortage).toBe(true);
  });

  it("supplier-entered expected quantity never moves stock by itself", () => {
    const d = confirmDelivery(10, 10, 0);
    expect(d.stockDelta).toBe(0);
  });

  it("rejects ledger replays that go negative", () => {
    expect(() => replayLedger([{ type: "opening_stock", quantity: 1 }, { type: "consumption", quantity: -2 }])).toThrow(NegativeStockError);
  });

  it("enforces transaction signs", () => {
    expect(() => replayLedger([{ type: "consumption", quantity: 3 }])).toThrow(/Invalid sign/);
    expect(() => replayLedger([{ type: "stockout", quantity: -1 }])).toThrow(/Invalid sign/);
    expect(() => replayLedger([{ type: "delivery_received", quantity: 1.5 }])).toThrow(/whole cans/);
  });
});

describe("daily consumption", () => {
  it("reduces stock and records one entry", () => {
    const r = applyConsumption(10, null, 2);
    expect(r.stockAfter).toBe(8);
    expect(r.record).toEqual({ quantity: 2, unmet: 0 });
    expect(r.entries).toEqual([{ type: "consumption", quantity: -2 }]);
  });

  it("editing a day only posts the difference", () => {
    const first = applyConsumption(10, null, 2);
    const edit = applyConsumption(first.stockAfter, first.record, 3);
    expect(edit.stockAfter).toBe(7);
    expect(edit.entries).toEqual([{ type: "consumption", quantity: -1 }]);
    const back = applyConsumption(edit.stockAfter, edit.record, 1);
    expect(back.stockAfter).toBe(9);
    expect(back.entries).toEqual([{ type: "adjustment", quantity: 2 }]);
  });

  it("never goes negative; unmet demand becomes a stockout", () => {
    const r = applyConsumption(1, null, 3);
    expect(r.stockAfter).toBe(0);
    expect(r.record).toEqual({ quantity: 1, unmet: 2 });
    expect(r.entries.map((e) => e.type)).toEqual(["consumption", "stockout"]);
    const lowered = applyConsumption(0, r.record, 2);
    expect(lowered.record).toEqual({ quantity: 1, unmet: 1 });
    expect(lowered.stockAfter).toBe(0);
  });
});

describe("stock levels & low-stock alert thresholds", () => {
  it("classifies levels with default critical threshold of 1", () => {
    expect(stockLevel(5, 3, 1)).toBe("ok");
    expect(stockLevel(3, 3, 1)).toBe("low");
    expect(stockLevel(1, 3, 1)).toBe("critical");
    expect(stockLevel(0, 3, 1)).toBe("critical");
    expect(stockLevel(4, 3, 1, false)).toBe("unknown");
    expect(stockLevel(null, 3, 1)).toBe("unknown");
  });
});

describe("stock prediction", () => {
  const base = {
    stockConfirmed: true,
    today: "2026-11-25",
    lowThreshold: 3,
    criticalThreshold: 1,
    leadDays: 1,
    safetyStock: 2,
  };

  it("uses 7-day history when at least 3 days are recorded", () => {
    const p = computePrediction({
      ...base,
      stock: 9,
      configuredDaily: 5,
      history: [
        { date: "2026-11-23", quantity: 2 },
        { date: "2026-11-24", quantity: 3 },
        { date: "2026-11-25", quantity: 1 },
        { date: "2026-11-10", quantity: 40 }, // outside window
      ],
    });
    expect(p.basis).toBe("history");
    expect(p.avgDailyConsumption).toBe(2);
    expect(p.daysRemaining).toBe(4.5);
    expect(p.predictedEmptyDate).toBe("2026-11-29");
    expect(p.orderNow).toBe(false);
  });

  it("falls back to configured consumption with insufficient history", () => {
    const p = computePrediction({ ...base, stock: 9, configuredDaily: 2, history: [{ date: "2026-11-25", quantity: 2 }] });
    expect(p.basis).toBe("configured");
    expect(p.daysRemaining).toBe(4.5);
  });

  it("shows no prediction without any consumption data", () => {
    const p = computePrediction({ ...base, stock: 9, configuredDaily: 0, history: [] });
    expect(p.daysRemaining).toBeNull();
    expect(p.predictedEmptyDate).toBeNull();
    expect(p.basis).toBeNull();
  });

  it("2 cans, 2/day, 1-day lead time → order now, recommend 2", () => {
    const p = computePrediction({ ...base, stock: 2, configuredDaily: 2, history: [] });
    expect(p.orderNow).toBe(true);
    expect(p.recommendedOrderQuantity).toBe(2); // 2×1 + 2 − 2
  });

  it("does not predict for unconfirmed stock", () => {
    const p = computePrediction({ ...base, stockConfirmed: false, stock: 0, configuredDaily: 2, history: [] });
    expect(p.level).toBe("unknown");
    expect(p.daysRemaining).toBeNull();
  });

  it("days of water after an order", () => {
    expect(daysOfWater(2, 2, 10)).toBe(6);
    expect(daysOfWater(2, null, 10)).toBeNull();
  });
});

describe("order workflow", () => {
  it("allows only valid transitions", () => {
    expect(canTransition("pending", "accepted")).toBe(true);
    expect(canTransition("pending", "out_for_delivery")).toBe(false);
    expect(canTransition("accepted", "delivered")).toBe(false);
    expect(canTransition("delivered", "cancelled")).toBe(false);
  });
  it("delivery recording requires acceptance; customers cancel only pending", () => {
    expect(canRecordDelivery("pending")).toBe(false);
    expect(canRecordDelivery("out_for_delivery")).toBe(true);
    expect(canCustomerCancel("pending")).toBe(true);
    expect(canCustomerCancel("accepted")).toBe(false);
  });
  it("flags bulk orders by threshold", () => {
    expect(isBulkOrder(25, 10)).toBe(true);
    expect(isBulkOrder(4, 10)).toBe(false);
    expect(isBulkOrder(4, 10, true)).toBe(true);
  });
});

describe("monthly billing", () => {
  it("bills confirmed deliveries only", () => {
    const calc = calculateInvoice({
      deliveries: [
        { status: "confirmed", confirmedQuantity: 8, unitPrice: 40 },
        { status: "confirmed", confirmedQuantity: 4, unitPrice: 40 },
        { status: "awaiting_confirmation", confirmedQuantity: null, unitPrice: 40 },
        { status: "confirmed", confirmedQuantity: 5, unitPrice: 40, alreadyInvoiced: true },
      ],
      taxRate: 0,
      previousBalance: 0,
      paymentsReceived: 0,
      credits: 0,
    });
    expect(calc.totalQuantity).toBe(12);
    expect(calc.subtotal).toBe(480);
    expect(calc.amountDue).toBe(480);
    expect(calc.lineCount).toBe(2);
  });

  it("chains previous balance, payments, credits, adjustments and tax", () => {
    const calc = calculateInvoice({
      deliveries: [{ status: "confirmed", confirmedQuantity: 6, unitPrice: 40 }],
      adjustments: [{ delta: -1, unitPrice: 40 }],
      taxRate: 5,
      previousBalance: 480,
      paymentsReceived: 380,
      credits: 20,
    });
    expect(calc.subtotal).toBe(200);
    expect(calc.taxAmount).toBe(10);
    expect(calc.amountDue).toBe(290);
  });

  it("partial payments and overdue status", () => {
    expect(invoiceStatus(480, 0, "2026-12-10", "2026-12-01")).toBe("unpaid");
    expect(invoiceStatus(480, 200, "2026-12-10", "2026-12-01")).toBe("partially_paid");
    expect(invoiceStatus(480, 480, "2026-12-10", "2026-12-01")).toBe("paid");
    expect(invoiceStatus(480, 200, "2026-12-10", "2026-12-11")).toBe("overdue");
    expect(invoiceStatus(-20, 0, "2026-12-10", "2026-12-11")).toBe("paid");
  });

  it("computes the completed billing period", () => {
    expect(billingPeriodFor(1, "2026-12-01")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(billingPeriodFor(1, "2026-11-25")).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(billingPeriodFor(15, "2026-01-10")).toEqual({ start: "2025-11-15", end: "2025-12-14" });
    expect(billingPeriodFor(5, "2026-01-05")).toEqual({ start: "2025-12-05", end: "2026-01-04" });
  });
});
