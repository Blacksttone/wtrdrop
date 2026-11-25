import { useQuery } from "@tanstack/react-query";
import { Pencil, Truck, XCircle } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { useSupplier } from "@/auth/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatCard } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { StatusBadge } from "@/components/water/StatusBadge";
import { formatDate } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import type { Delivery } from "@/types/db";
import { AdjustDeliveryDialog, RecordDeliveryDialog } from "./dialogs";

export default function SupplierDeliveries() {
  const supplier = useSupplier();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = React.useState("all");
  const [adjusting, setAdjusting] = React.useState<Delivery | null>(null);
  const creating = params.get("new") === "1";
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["deliveries", "supplier", supplier.id, status],
    queryFn: async () => {
      let q = supabase.from("deliveries").select("*, customers(customer_name)").eq("supplier_id", supplier.id).order("delivery_date", { ascending: false }).order("created_at", { ascending: false }).limit(300);
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return data as Delivery[];
    },
  });
  const cancel = useAction((id: string) => rpc("cancel_delivery", { p_delivery_id: id, p_reason: "Recorded by mistake" }), { success: "Delivery cancelled", invalidate: [["deliveries"]] });
  const confirmed = (data ?? []).filter((d) => d.status === "confirmed");
  const exact = confirmed.filter((d) => d.discrepancy === 0).length;
  const short = confirmed.reduce((s, d) => s + Math.max(-(d.discrepancy ?? 0), 0), 0);

  return (
    <div>
      <PageHeader title="Deliveries" description="Customer-confirmed quantities drive stock and billing." actions={<Button onClick={() => setParams({ new: "1" })}><Truck /> Record delivery</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Awaiting confirmation" value={(data ?? []).filter((d) => d.status === "awaiting_confirmation").length} tone="low" />
        <StatCard label="Confirmed" value={confirmed.length} tone="ok" />
        <StatCard label="Delivery accuracy" value={confirmed.length ? `${Math.round((exact / confirmed.length) * 100)}%` : "—"} hint="Confirmed = expected" />
        <StatCard label="Cans short" value={short} tone={short ? "critical" : "default"} />
      </div>
      <div className="mb-3 max-w-xs">
        <Select aria-label="Filter status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option><option value="awaiting_confirmation">Awaiting confirmation</option><option value="confirmed">Confirmed</option><option value="cancelled">Cancelled</option>
        </Select>
      </div>
      {isLoading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? (
        <EmptyState icon={Truck} title="No deliveries" description="Record a delivery after dropping off cans." />
      ) : (
        <Card>
          <Table>
            <THead><TR><TH>Date</TH><TH>Customer</TH><TH>Expected</TH><TH>Delivered</TH><TH>Confirmed</TH><TH>Difference</TH><TH>Status</TH><TH /></TR></THead>
            <TBody>
              {data.map((d) => (
                <TR key={d.id}>
                  <TD>{formatDate(d.delivery_date, "d MMM")}</TD>
                  <TD className="font-medium">{d.customers?.customer_name}{d.order_id && <Badge variant="muted" className="ml-1">order</Badge>}</TD>
                  <TD>{d.expected_quantity}</TD>
                  <TD>{d.actual_quantity}</TD>
                  <TD>{d.confirmed_quantity ?? "—"}{d.adjusted_quantity ? <span className="text-xs text-muted-foreground"> ({d.adjusted_quantity > 0 ? "+" : ""}{d.adjusted_quantity})</span> : null}{d.confirmed_by_supplier && <Badge variant="muted" className="ml-1">by you</Badge>}</TD>
                  <TD>{d.discrepancy == null ? "—" : d.discrepancy === 0 ? <span className="text-stock-ok">exact</span> : <span className={d.discrepancy < 0 ? "font-semibold text-stock-critical" : "text-primary"}>{d.discrepancy > 0 ? "+" : ""}{d.discrepancy}</span>}</TD>
                  <TD><StatusBadge status={d.status} /></TD>
                  <TD>
                    {d.status === "confirmed" && <Button variant="ghost" size="icon" aria-label="Adjust" onClick={() => setAdjusting(d)}><Pencil /></Button>}
                    {d.status === "awaiting_confirmation" && <Button variant="ghost" size="icon" aria-label="Cancel delivery" onClick={() => { if (confirm("Cancel this unconfirmed delivery?")) cancel.mutate(d.id); }}><XCircle /></Button>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      {creating && <RecordDeliveryDialog onClose={() => setParams({})} />}
      {adjusting && <AdjustDeliveryDialog delivery={adjusting} onClose={() => setAdjusting(null)} />}
    </div>
  );
}
