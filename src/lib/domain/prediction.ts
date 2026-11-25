/**
 * Stock prediction (mirror of public.compute_prediction).
 *  avg daily = consumption over the recorded span in the last 7 days
 *              (needs ≥ 3 recorded days, else the configured daily consumption)
 *  days remaining = stock / avg
 *  empty date = today + floor(days remaining)
 *  recommended = ceil(avg × lead days) + safety stock − stock
 */
import { addDays, differenceInCalendarDays, parseISO } from "date-fns";
import { stockLevel, type StockLevel } from "./stock";

export interface ConsumptionPoint {
  date: string; // yyyy-MM-dd
  quantity: number;
  unmet?: number;
}

export interface PredictionInput {
  stock: number;
  stockConfirmed: boolean;
  history: ConsumptionPoint[];
  today: string; // yyyy-MM-dd (customer local)
  configuredDaily: number;
  lowThreshold: number;
  criticalThreshold: number;
  leadDays: number;
  safetyStock: number;
}

export interface Prediction {
  level: StockLevel;
  avgDailyConsumption: number | null;
  basis: "history" | "configured" | null;
  daysWithData: number;
  daysRemaining: number | null;
  predictedEmptyDate: string | null;
  recommendedOrderQuantity: number;
  orderNow: boolean;
}

export const MIN_HISTORY_DAYS = 3;
export const WINDOW_DAYS = 7;

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function computePrediction(input: PredictionInput): Prediction {
  const today = parseISO(input.today);
  const windowStart = addDays(today, -(WINDOW_DAYS - 1));
  const inWindow = input.history.filter((h) => {
    const d = parseISO(h.date);
    return d >= windowStart && d <= today;
  });

  let avg: number | null = null;
  let basis: Prediction["basis"] = null;
  if (inWindow.length >= MIN_HISTORY_DAYS) {
    const dates = inWindow.map((h) => parseISO(h.date)).sort((a, b) => a.getTime() - b.getTime());
    const span = differenceInCalendarDays(dates[dates.length - 1], dates[0]) + 1;
    const total = inWindow.reduce((s, h) => s + h.quantity + (h.unmet ?? 0), 0);
    avg = round(total / Math.max(span, 1), 2);
    basis = "history";
  } else if (input.configuredDaily > 0) {
    avg = input.configuredDaily;
    basis = "configured";
  }

  const level = stockLevel(input.stock, input.lowThreshold, input.criticalThreshold, input.stockConfirmed);
  let daysRemaining: number | null = null;
  let emptyDate: string | null = null;
  let recommended = 0;
  let orderNow = false;

  if (avg !== null && avg > 0 && level !== "unknown") {
    daysRemaining = round(input.stock / avg, 1);
    emptyDate = iso(addDays(today, Math.floor(daysRemaining)));
    recommended = Math.max(Math.ceil(avg * Math.max(input.leadDays, 1)) + input.safetyStock - input.stock, 0);
    orderNow = daysRemaining <= input.leadDays + 1 || input.stock <= input.lowThreshold;
  } else if (level === "low" || level === "critical") {
    orderNow = true;
    recommended = Math.max(input.safetyStock + input.lowThreshold - input.stock + 1, 1);
  }
  if (orderNow && recommended < 1) recommended = 1;

  return {
    level,
    avgDailyConsumption: avg,
    basis,
    daysWithData: inWindow.length,
    daysRemaining,
    predictedEmptyDate: emptyDate,
    recommendedOrderQuantity: recommended,
    orderNow,
  };
}

/** Days of water after receiving `extra` cans, given an average daily use. */
export function daysOfWater(stock: number, avg: number | null, extra = 0): number | null {
  if (!avg || avg <= 0) return null;
  return round((stock + extra) / avg, 1);
}
