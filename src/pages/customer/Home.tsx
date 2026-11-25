import { AlertTriangle, CalendarDays, ChevronRight, Droplets, FileText, PackageCheck, Truck } from "lucide-react";
import { Link } from "react-router-dom";
import { useCustomer } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorState, Skeleton } from "@/components/ui/states";
import { LevelPill, StockGauge } from "@/components/water/StockGauge";
import { StatusBadge } from "@/components/water/StatusBadge";
import { formatDate, formatMoney } from "@/lib/format";
import { useCustomerSummary } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { QuickConsumption } from "./QuickConsumption";

export default function CustomerHome() {
  const customer = useCustomer();
  const { data: s, isLoading, error, refetch } = useCustomerSummary(customer.id);

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-72" /><Skeleton className="h-20" /><Skeleton className="h-32" /></div>;
  if (error || !s) return <ErrorState error={error} onRetry={refetch} />;
  const p = s.prediction;
  const outstanding = Math.max(Number(s.outstanding_balance), 0);
  const capacity = Math.max(p.current_stock, s.thresholds.low * 3, (p.avg_daily_consumption ?? 1) * 7, 10);

  return (
    <div className="space-y-4">
      {s.pending_confirmations > 0 && (
        <Link to="/app/deliveries" className="flex items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900">
          <PackageCheck className="h-6 w-6 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold">Confirm your delivery</p>
            <p className="text-sm">{s.pending_confirmations} deliver{s.pending_confirmations === 1 ? "y is" : "ies are"} waiting. Stock updates only after you confirm.</p>
          </div>
          <ChevronRight className="h-5 w-5" />
        </Link>
      )}

      {/* 1. How many cans do I have? */}
      <Card className="overflow-hidden">
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Water cans available</p>
            <LevelPill level={p.level} />
          </div>
          <div className="mt-2 grid items-center gap-4 sm:grid-cols-[auto_1fr]">
            <StockGauge stock={p.current_stock} level={p.level} capacity={capacity} />
            {/* 2. When will my water run out? */}
            <div className="space-y-3">
              {!p.stock_confirmed ? (
                <p className="rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
                  Stock not confirmed yet. Confirm a delivery or set your current cans in <Link to="/app/settings" className="font-semibold text-primary underline">Settings</Link>.
                </p>
              ) : p.days_remaining == null ? (
                <p className="rounded-lg bg-slate-100 p-3 text-sm text-slate-700">Consumption data needed to calculate stock prediction.</p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-secondary p-3">
                    <p className="text-xs text-muted-foreground">Water lasts</p>
                    <p className="text-xl font-bold">{p.days_remaining} day{p.days_remaining === 1 ? "" : "s"}</p>
                  </div>
                  <div className="rounded-xl bg-secondary p-3">
                    <p className="text-xs text-muted-foreground">Runs out on</p>
                    <p className="text-xl font-bold">{formatDate(p.predicted_empty_date, "EEE, d MMM")}</p>
                  </div>
                  <div className="col-span-2 text-xs text-muted-foreground">
                    Average use {p.avg_daily_consumption} cans/day
                    {p.basis === "configured" ? " (your setting — log daily usage for better accuracy)" : ` (last ${p.days_with_data} days)`}.
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 3. Should I order now? */}
      <div className={cn("rounded-2xl p-4", p.order_now ? (p.level === "critical" ? "bg-red-50 ring-1 ring-red-200" : "bg-amber-50 ring-1 ring-amber-200") : "bg-emerald-50 ring-1 ring-emerald-200")}>
        <div className="flex items-start gap-3">
          {p.order_now ? <AlertTriangle className={cn("mt-0.5 h-5 w-5 shrink-0", p.level === "critical" ? "text-stock-critical" : "text-amber-600")} /> : <Droplets className="mt-0.5 h-5 w-5 shrink-0 text-stock-ok" />}
          <div className="text-sm">
            {p.order_now ? (
              <>
                <p className="font-semibold">{p.level === "critical" ? (p.current_stock === 0 ? "You're out of water. Order now." : `Water stock is critically low. You have ${p.current_stock} can${p.current_stock === 1 ? "" : "s"} remaining.`) : "Order now to avoid running out."}</p>
                <p className="mt-0.5 text-muted-foreground">Delivery takes about {p.delivery_lead_days} day{p.delivery_lead_days === 1 ? "" : "s"}. We recommend ordering <b>{p.recommended_order_quantity} cans</b>.</p>
              </>
            ) : (
              <p className="font-semibold text-emerald-900">You have enough water for now. No need to order yet.</p>
            )}
          </div>
        </div>
        <Button asChild size="xl" className="mt-4 w-full">
          <Link to={`/app/order${p.order_now ? `?qty=${p.recommended_order_quantity}` : ""}`}><Truck /> Order Water</Link>
        </Button>
      </div>

      <QuickConsumption customerId={customer.id} today={p.today} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Link to="/app/orders" className="block">
          <Card className="h-full transition-shadow hover:shadow-md">
            <CardContent className="flex items-center gap-3 p-4">
              <Truck className="h-5 w-5 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Latest order</p>
                {s.latest_order ? (
                  <p className="font-semibold">{s.latest_order.quantity} cans <StatusBadge status={s.latest_order.status} /></p>
                ) : <p className="font-semibold">No orders yet</p>}
                {s.next_delivery_date && <p className="text-xs text-muted-foreground"><CalendarDays className="mr-1 inline h-3 w-3" />Next delivery {formatDate(s.next_delivery_date, "EEE, d MMM")}</p>}
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </CardContent>
          </Card>
        </Link>
        <Link to="/app/bills" className="block">
          <Card className="h-full transition-shadow hover:shadow-md">
            <CardContent className="flex items-center gap-3 p-4">
              <FileText className="h-5 w-5 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Outstanding bill</p>
                <p className={cn("font-semibold", outstanding > 0 && "text-amber-700")}>{formatMoney(outstanding)}</p>
                {s.latest_invoice && <p className="text-xs text-muted-foreground">Due {formatDate(s.latest_invoice.due_date)} · <StatusBadge status={s.latest_invoice.status} /></p>}
                {Number(s.unbilled.amount) > 0 && <p className="text-xs text-muted-foreground">+ {formatMoney(s.unbilled.amount)} this month so far</p>}
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
