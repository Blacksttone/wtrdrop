import { format, formatDistanceToNow, parseISO } from "date-fns";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

export const formatMoney = (n: number | string | null | undefined) => inr.format(Number(n ?? 0));
export const formatCans = (n: number | null | undefined) => `${n ?? 0} can${n === 1 ? "" : "s"}`;

export function formatDate(d: string | Date | null | undefined, pattern = "d MMM yyyy") {
  if (!d) return "—";
  const date = typeof d === "string" ? parseISO(d) : d;
  return Number.isNaN(date.getTime()) ? "—" : format(date, pattern);
}

export const formatDateTime = (d: string | null | undefined) => formatDate(d, "d MMM yyyy, h:mm a");
export const timeAgo = (d: string) => formatDistanceToNow(parseISO(d), { addSuffix: true });
export const todayISO = () => format(new Date(), "yyyy-MM-dd");
export const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
