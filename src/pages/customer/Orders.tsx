import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Check, Minus, Package, Plus, Truck } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useCustomer } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input, Switch } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { StatusBadge } from "@/components/water/StatusBadge";
import { canCustomerCancel, ORDER_STEPS, type OrderStatus } from "@/lib/domain/orders";
import { daysOfWater } from "@/lib/domain/prediction";
import { formatDate, formatMoney, timeAgo, titleCase } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { useCustomerOrders, useCustomerSummary, useSupplierSettings } from "@/lib/queries";
import { rpc } from "@/lib/supabase";
import { cn } from "@/lib/utils";

export function NewOrder() {
  const customer = useCustomer();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const summary = useCustomerSummary(customer.id);
  const settings = useSupplierSettings(customer.supplier_id);
  const [qty, setQty] = React.useState(() => Math.max(Number(params.get("qty")) || 0, 0) || 5);
  const [bulk, setBulk] = React.useState(false);
  const [date, setDate] = React.useState("");
  const [notes, setNotes] = React.useState(customer.delivery_instructions ?? "");
  const p = summary.data?.prediction;
  const threshold = settings.data?.bulk_order_threshold ?? 10;
  const isBulk = bulk || qty >= threshold;
  const price = customer.can_price ?? settings.data?.default_can_price ?? 0;
  const after = daysOfWater(p?.current_stock ?? 0, p?.avg_daily_consumption ?? null, qty);
  const today = p?.today ?? new Date().toISOString().slice(0, 10);

  const place = useAction(
    () => rpc("place_order", { p_customer_id: customer.id, p_quantity: qty, p_requested_delivery_date: date || null, p_delivery_instructions: notes || null, p_is_bulk: bulk }),
    { success: "Order placed! Your supplier has been notified.", onSuccess: () => { qc.invalidateQueries(); navigate("/app/orders"); } },
  );

  const presets = Array.from(new Set([p?.recommended_order_quantity || 0, 2, 5, 10, 20].filter((n) => n > 0))).sort((a, b) => a - b).slice(0, 5);

  return (
    <div>
      <PageHeader title="Order water" description="Your supplier will confirm and schedule the delivery." />
      <Card>
        <CardContent className="space-y-6 p-5">
          <div>
            <p className="text-sm font-medium">How many cans?</p>
            <div className="mt-3 flex items-center justify-center gap-4">
              <Button variant="outline" size="icon" className="h-14 w-14 rounded-full" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Fewer cans"><Minus /></Button>
              <Input aria-label="Quantity" type="number" min={1} max={1000} value={qty} onChange={(e) => setQty(Math.min(1000, Math.max(1, Number(e.target.value) || 1)))} className="h-16 w-28 text-center text-3xl font-bold" />
              <Button variant="outline" size="icon" className="h-14 w-14 rounded-full" onClick={() => setQty(Math.min(1000, qty + 1))} aria-label="More cans"><Plus /></Button>
            </div>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {presets.map((n) => (
                <button key={n} onClick={() => setQty(n)} className={cn("rounded-full border px-4 py-1.5 text-sm font-semibold", qty === n ? "border-primary bg-primary text-white" : "hover:bg-secondary")}>
                  {n}{n === p?.recommended_order_quantity ? " · recommended" : ""}
                </button>
              ))}
            </div>
            {after != null && (
              <p className="mt-3 text-center text-sm text-muted-foreground">With {qty} more cans your water lasts about <b className="text-foreground">{after} days</b>.</p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-xl bg-secondary p-3">
            <div>
              <p className="text-sm font-semibold">Bulk order</p>
              <p className="text-xs text-muted-foreground">For events or offices. Orders of {threshold}+ cans are bulk automatically.</p>
            </div>
            <Switch id="bulk" label="Bulk order" checked={isBulk} onChange={setBulk} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Preferred delivery date (optional)" htmlFor="date">
              <Input id="date" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Delivery instructions" htmlFor="notes">
              <Input id="notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Leave at the gate" />
            </Field>
          </div>

          <div className="flex items-center justify-between border-t pt-4 text-sm">
            <span className="text-muted-foreground">Estimated ({formatMoney(price)}/can) — billed on delivered cans</span>
            <span className="text-lg font-bold">{formatMoney(price * qty)}</span>
          </div>
          <Button size="xl" className="w-full" loading={place.isPending} onClick={() => place.mutate(undefined)}>
            <Truck /> Place order for {qty} can{qty === 1 ? "" : "s"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Tracker({ status }: { status: OrderStatus }) {
  if (status === "cancelled" || status === "rejected") return null;
  const idx = ORDER_STEPS.indexOf(status);
  return (
    <ol className="mt-3 grid grid-cols-5 gap-1" aria-label="Order progress">
      {ORDER_STEPS.map((s, i) => (
        <li key={s} className="flex flex-col items-center gap-1 text-center">
          <span className={cn("flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold", i <= idx ? "bg-primary text-white" : "bg-muted text-muted-foreground")}>
            {i < idx ? <Check className="h-3 w-3" /> : i + 1}
          </span>
          <span className={cn("text-[10px] leading-tight", i <= idx ? "font-semibold text-foreground" : "text-muted-foreground")}>{titleCase(s)}</span>
        </li>
      ))}
    </ol>
  );
}

export function OrdersList() {
  const customer = useCustomer();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useCustomerOrders(customer.id);
  const cancel = useAction((id: string) => rpc("cancel_order", { p_order_id: id, p_reason: "Cancelled by customer" }), {
    success: "Order cancelled", onSuccess: () => qc.invalidateQueries(),
  });
  return (
    <div>
      <PageHeader title="My orders" actions={<Button asChild><Link to="/app/order"><Truck /> Order Water</Link></Button>} />
      <div className="mb-4 flex gap-2"><Button variant="outline" size="sm" asChild><Link to="/app/deliveries"><Package /> Delivery history</Link></Button></div>
      {isLoading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? (
        <EmptyState icon={Truck} title="No orders yet" description="Place your first order and track it here." action={<Button asChild><Link to="/app/order">Order Water</Link></Button>} />
      ) : (
        <div className="space-y-3">
          {data.map((o) => (
            <Card key={o.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-lg font-bold">{o.quantity} cans {o.is_bulk && <span className="ml-1 rounded bg-secondary px-1.5 py-0.5 text-xs text-primary">Bulk</span>}</p>
                    <p className="text-xs text-muted-foreground">Ordered {timeAgo(o.created_at)}</p>
                  </div>
                  <StatusBadge status={o.status} />
                </div>
                {(o.scheduled_date || o.requested_delivery_date) && (
                  <p className="mt-2 flex items-center gap-1 text-sm"><CalendarDays className="h-4 w-4 text-primary" />
                    {o.scheduled_date ? `Scheduled for ${formatDate(o.scheduled_date, "EEE, d MMM")}` : `Requested for ${formatDate(o.requested_delivery_date, "EEE, d MMM")}`}
                  </p>
                )}
                {o.status_reason && (o.status === "rejected" || o.status === "cancelled") && <p className="mt-2 text-sm text-muted-foreground">Reason: {o.status_reason}</p>}
                <Tracker status={o.status} />
                {o.status === "delivered" && <p className="mt-3 text-sm"><Link to="/app/deliveries" className="font-semibold text-primary">Confirm received cans →</Link></p>}
                {canCustomerCancel(o.status) && (
                  <Button variant="outline" size="sm" className="mt-3" loading={cancel.isPending && cancel.variables === o.id}
                    onClick={() => { if (confirm("Cancel this order?")) cancel.mutate(o.id); }}>Cancel order</Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

