/**
 * Billing rules (mirror of public.generate_invoice_for_customer).
 * Bills come from CONFIRMED deliveries only — never from consumption.
 *   amount due = previous balance + current charges − payments − credits
 */
export interface BillableDelivery {
  status: "awaiting_confirmation" | "confirmed" | "cancelled";
  confirmedQuantity: number | null;
  unitPrice: number;
  alreadyInvoiced?: boolean;
}

export interface InvoiceCalcInput {
  deliveries: BillableDelivery[];
  adjustments?: { delta: number; unitPrice: number; alreadyInvoiced?: boolean }[];
  taxRate: number;
  previousBalance: number;
  paymentsReceived: number;
  credits: number;
}

export interface InvoiceCalc {
  totalQuantity: number;
  subtotal: number;
  taxAmount: number;
  currentCharges: number;
  amountDue: number;
  lineCount: number;
}

export const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function calculateInvoice(input: InvoiceCalcInput): InvoiceCalc {
  const lines = [
    ...input.deliveries
      .filter((d) => d.status === "confirmed" && d.confirmedQuantity != null && !d.alreadyInvoiced)
      .map((d) => ({ qty: d.confirmedQuantity as number, amount: money((d.confirmedQuantity as number) * d.unitPrice) })),
    ...(input.adjustments ?? [])
      .filter((a) => !a.alreadyInvoiced)
      .map((a) => ({ qty: a.delta, amount: money(a.delta * a.unitPrice) })),
  ];
  const totalQuantity = lines.reduce((s, l) => s + l.qty, 0);
  const subtotal = money(lines.reduce((s, l) => s + l.amount, 0));
  const taxAmount = money((subtotal * input.taxRate) / 100);
  const currentCharges = money(subtotal + taxAmount);
  const amountDue = money(input.previousBalance + currentCharges - input.paymentsReceived - input.credits);
  return { totalQuantity, subtotal, taxAmount, currentCharges, amountDue, lineCount: lines.length };
}

export type InvoiceStatus = "unpaid" | "partially_paid" | "paid" | "overdue";

export function invoiceStatus(amountDue: number, amountPaid: number, dueDate: string, today: string): InvoiceStatus {
  if (amountDue <= 0 || amountPaid >= amountDue) return "paid";
  if (dueDate < today) return "overdue";
  if (amountPaid > 0) return "partially_paid";
  return "unpaid";
}

/** The billing period that most recently completed as of `asOf` (billing day 1–28). */
export function billingPeriodFor(billingDay: number, asOf: string): { start: string; end: string } {
  if (billingDay < 1 || billingDay > 28) throw new Error("Billing day must be 1–28");
  const [y, m, d] = asOf.split("-").map(Number);
  let billY = y;
  let billM = m;
  if (d < billingDay) {
    billM -= 1;
    if (billM === 0) {
      billM = 12;
      billY -= 1;
    }
  }
  const billDate = new Date(Date.UTC(billY, billM - 1, billingDay));
  const end = new Date(billDate.getTime() - 86_400_000);
  const start = new Date(Date.UTC(billM === 1 ? billY - 1 : billY, billM === 1 ? 11 : billM - 2, billingDay));
  const f = (x: Date) => x.toISOString().slice(0, 10);
  return { start: f(start), end: f(end) };
}
