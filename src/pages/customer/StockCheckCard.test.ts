import { describe, expect, it } from "vitest";
import { stockCheckDue } from "./StockCheckCard";

const sunday = new Date("2026-11-29T08:30:00+05:30");
const wednesday = new Date("2026-12-02T10:00:00+05:30");

describe("stockCheckDue", () => {
  it("always shows when opened from the reminder", () => {
    expect(stockCheckDue({ last_stock_check_at: sunday.toISOString() }, sunday, true)).toBe(true);
  });
  it("shows on the weekend when not counted this week", () => {
    expect(stockCheckDue({ last_stock_check_at: null }, sunday)).toBe(true);
    expect(stockCheckDue({ last_stock_check_at: "2026-11-20T10:00:00+05:30" }, sunday)).toBe(true);
  });
  it("hides after counting, and on weekdays", () => {
    expect(stockCheckDue({ last_stock_check_at: "2026-11-29T08:10:00+05:30" }, sunday)).toBe(false);
    expect(stockCheckDue({ last_stock_check_at: null }, wednesday)).toBe(false);
  });
});
