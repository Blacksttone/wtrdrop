import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ClipboardList, Truck } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { useSupplier } from "@/auth/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { StatusBadge } from "@/components/water/StatusBadge";
import { canRecordDelivery, nextSupplierStatuses, OPEN_STATUSES, type OrderStatus } from "@/lib/domain/orders";
import { formatDate, timeAgo, titleCase, todayISO } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { Order } from "@/types/db";
import { RecordDeliveryDialog } from "./dialogs";

const TABS = [
  { key: "open", label: "Open", statuses: OPEN_STATUSES },
  { key: "pending", label: "Pending", statuses: ["pending"] as OrderStatus[] },
  { key: "done", label: "Completed", statuses: ["delivered", "cancelled", "rejected"] as OrderStatus[] },
];

function StatusDialog({ order, to, onClose }: { order: Order; to: OrderStatus; onClose: () => void }) {
  const [date, setDate] = React.useState(order.scheduled_date ?? order.requested_delivery_date ?? todayISO());
  const [reason, setReason] = React.useState("");
  const needsReason = to === "rejected" || to === "cancelled";
  const save = useAction(() => rpc("update_order_status", { p_order_id: order.id, p_status: to, p_scheduled_date: to === "accepted" ? date : null, p_reason: reason || null }), {
    success: `Order ${titleCase(to).toLowerCase()}`, invalidate: [["orders"], ["supplier-dashboard"]], onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`${titleCase(to)} order`} description={`${order.quantity} cans for ${order.customers?.customer_name}`}>
        <div className="space-y-4">
          {to === "accepted" && <Field label="Scheduled delivery date" htmlFor="sd"><Input id="sd" type="date" min={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>}
          {needsReason && <Field label="Reason (shared with customer)" htmlFor="rs"><Textarea id="rs" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
          <Button className="w-full" variant={needsReason ? "destructive" : "default"} disabled={to === "rejected" && reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {titleCase(to)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function SupplierOrders() {
  const supplier = useSupplier();
  const [tab, setTab] = React.useState("open");
  const [action, setAction] = React.useState<{ order: Order; to: OrderStatus } | null>(null);
  const [delivering, setDelivering] = React.useState<Order | null>(null);
  const statuses = TABS.find((t) => t.key === tab)!.statuses;
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["orders", "supplier", supplier.id, tab],
    queryFn: async () => {
      const { data, error } = await supabase.from("orders").select("*, customers(customer_name, address, phone)").eq("supplier_id", supplier.id).in("status", statuses)
        // Open work: first come, first served. Completed: newest first.
        .order("created_at", { ascending: tab !== "done" }).limit(300);
      if (error) throw error;
      return data as Order[];
    },
    refetchInterval: 60_000,
  });
  const quick = useAction((v: { id: string; to: OrderStatus }) => rpc("update_order_status", { p_order_id: v.id, p_status: v.to }), {
    success: "Order updated", invalidate: [["orders"], ["supplier-dashboard"]],
  });

  return (
    <div>
      <PageHeader title="Orders" description="First come, first served: the oldest open order is at the top." />
      <div className="mb-4 inline-flex rounded-lg bg-muted p-1" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={cn("rounded-md px-4 py-1.5 text-sm font-medium", tab === t.key ? "bg-card shadow-sm" : "text-muted-foreground")}>{t.label}</button>
        ))}
      </div>
      {isLoading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? (
        <EmptyState icon={ClipboardList} title="No orders here" description="New customer orders appear instantly." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.map((o, i) => (
            <Card key={o.id} className={tab !== "done" && i === 0 ? "ring-2 ring-primary" : undefined}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    {tab !== "done" && <p className="text-xs font-bold text-primary">#{i + 1}{i === 0 ? " · do this first" : ""}</p>}
                    <Link to={`/supplier/customers/${o.customer_id}`} className="font-semibold hover:underline">{o.customers?.customer_name}</Link>
                    <p className="text-xs text-muted-foreground">{o.customers?.address}</p>
                  </div>
                  <StatusBadge status={o.status} />
                </div>
                <p className="mt-3 text-2xl font-extrabold">{o.quantity} cans {o.is_bulk && <Badge>Bulk</Badge>}</p>
                <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                  <CalendarDays className="h-4 w-4" />
                  {o.scheduled_date ? `Scheduled ${formatDate(o.scheduled_date, "EEE d MMM")}` : o.requested_delivery_date ? `Wants ${formatDate(o.requested_delivery_date, "EEE d MMM")}` : "Any day"}
                  <span className="ml-auto text-xs">{timeAgo(o.created_at)}</span>
                </p>
                {o.delivery_instructions && <p className="mt-2 rounded-md bg-muted p-2 text-xs">{o.delivery_instructions}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {nextSupplierStatuses(o.status).map((to) =>
                    to === "accepted" || to === "rejected" || to === "cancelled" ? (
                      <Button key={to} size="sm" variant={to === "accepted" ? "default" : "outline"} onClick={() => setAction({ order: o, to })}>{titleCase(to)}</Button>
                    ) : (
                      <Button key={to} size="sm" variant="secondary" loading={quick.isPending && quick.variables?.id === o.id} onClick={() => quick.mutate({ id: o.id, to })}>{titleCase(to)}</Button>
                    ),
                  )}
                  {canRecordDelivery(o.status) && <Button size="sm" variant="success" onClick={() => setDelivering(o)}><Truck /> Delivered</Button>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {action && <StatusDialog order={action.order} to={action.to} onClose={() => setAction(null)} />}
      {delivering && <RecordDeliveryDialog order={delivering} onClose={() => setDelivering(null)} />}
    </div>
  );
}
