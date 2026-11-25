import { Badge } from "@/components/ui/badge";
import { titleCase } from "@/lib/format";

type Variant = "default" | "success" | "warning" | "danger" | "muted";
const MAP: Record<string, Variant> = {
  pending: "warning",
  accepted: "default",
  preparing: "default",
  out_for_delivery: "default",
  delivered: "success",
  cancelled: "muted",
  rejected: "danger",
  awaiting_confirmation: "warning",
  confirmed: "success",
  unpaid: "warning",
  partially_paid: "default",
  paid: "success",
  overdue: "danger",
  succeeded: "success",
  failed: "danger",
  refunded: "muted",
  approved: "success",
  active: "success",
  suspended: "danger",
  inactive: "muted",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const text = label ?? (status === "awaiting_confirmation" ? "Awaiting confirmation" : status === "succeeded" ? "Received" : titleCase(status));
  return <Badge variant={MAP[status] ?? "default"}>{text}</Badge>;
}
