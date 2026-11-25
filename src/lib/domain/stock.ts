/**
 * Inventory ledger rules (mirror of the database engine in
 * supabase/migrations/*_security_and_ledger.sql and *_operations.sql).
 *
 * Current stock = opening + confirmed received − consumed − returned/damaged ± adjustments
 * Stock never goes negative: unmet consumption is recorded as a stockout.
 */
export type TransactionType =
  | "opening_stock"
  | "delivery_received"
  | "consumption"
  | "return"
  | "damage"
  | "adjustment"
  | "stockout";

export type StockLevel = "ok" | "low" | "critical" | "unknown";

export interface LedgerEntry {
  type: TransactionType;
  /** signed quantity: + increases stock, − decreases */
  quantity: number;
}

export class NegativeStockError extends Error {
  constructor(current: number, change: number) {
    super(`Stock cannot become negative (current ${current}, change ${change})`);
    this.name = "NegativeStockError";
  }
}

const SIGN_RULES: Record<TransactionType, (q: number) => boolean> = {
  opening_stock: (q) => q >= 0,
  delivery_received: (q) => q >= 0,
  consumption: (q) => q <= 0,
  return: (q) => q <= 0,
  damage: (q) => q <= 0,
  stockout: (q) => q === 0,
  adjustment: () => true,
};

export function assertValidEntry(entry: LedgerEntry): void {
  if (!Number.isInteger(entry.quantity)) throw new Error("Quantities are whole cans");
  if (!SIGN_RULES[entry.type](entry.quantity)) {
    throw new Error(`Invalid sign for ${entry.type}: ${entry.quantity}`);
  }
}

/** Replays a ledger and returns the running balance after each entry. */
export function replayLedger(entries: LedgerEntry[]): number[] {
  const balances: number[] = [];
  let balance = 0;
  for (const e of entries) {
    assertValidEntry(e);
    if (balance + e.quantity < 0) throw new NegativeStockError(balance, e.quantity);
    balance += e.quantity;
    balances.push(balance);
  }
  return balances;
}

export function currentStock(entries: LedgerEntry[]): number {
  const b = replayLedger(entries);
  return b.length ? b[b.length - 1] : 0;
}

export function stockLevel(
  stock: number | null | undefined,
  lowThreshold: number,
  criticalThreshold: number,
  confirmed = true,
): StockLevel {
  if (stock == null || !confirmed) return "unknown";
  if (stock <= criticalThreshold) return "critical";
  if (stock <= lowThreshold) return "low";
  return "ok";
}

export interface DeliveryConfirmation {
  stockDelta: number;
  /** confirmed − expected (negative = shortage) */
  discrepancy: number;
  /** confirmed − supplier-claimed actual */
  claimGap: number;
  isShortage: boolean;
}

/** Only the quantity the customer confirms moves stock. */
export function confirmDelivery(expected: number, actual: number, confirmed: number): DeliveryConfirmation {
  for (const q of [expected, actual, confirmed]) {
    if (!Number.isInteger(q) || q < 0 || q > 1000) throw new Error("Quantities must be 0–1000 cans");
  }
  return {
    stockDelta: confirmed,
    discrepancy: confirmed - expected,
    claimGap: confirmed - actual,
    isShortage: confirmed < expected || confirmed < actual,
  };
}

export interface DayRecord {
  quantity: number; // cans actually consumed from stock
  unmet: number; // demand that could not be met (stockout)
}

export interface ConsumptionResult {
  record: DayRecord;
  stockAfter: number;
  entries: LedgerEntry[];
}

/**
 * Sets the requested total for a day. Only the delta touches the ledger;
 * demand beyond available stock becomes a stockout event.
 */
export function applyConsumption(stock: number, previous: DayRecord | null, requested: number): ConsumptionResult {
  if (!Number.isInteger(requested) || requested < 0 || requested > 1000) {
    throw new Error("Consumption must be 0–1000 cans");
  }
  const prev = previous ?? { quantity: 0, unmet: 0 };
  const delta = requested - (prev.quantity + prev.unmet);
  const entries: LedgerEntry[] = [];
  let take = 0;
  let unmetChange = 0;
  if (delta > 0) {
    take = Math.min(delta, stock);
    unmetChange = delta - take;
    if (take > 0) entries.push({ type: "consumption", quantity: -take });
    if (unmetChange > 0) entries.push({ type: "stockout", quantity: 0 });
  } else if (delta < 0) {
    unmetChange = -Math.min(prev.unmet, -delta);
    take = delta - unmetChange; // ≤ 0 → cans returned
    if (take < 0) entries.push({ type: "adjustment", quantity: -take });
  }
  return {
    record: { quantity: prev.quantity + take, unmet: prev.unmet + unmetChange },
    stockAfter: stock - take,
    entries,
  };
}
