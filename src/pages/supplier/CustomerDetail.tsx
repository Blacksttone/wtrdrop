import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Boxes, FileMinus, Pencil, Truck, Wallet } from "lucide-react";
import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { ErrorState, LoadingState, PageHeader, StatCard } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LevelPill } from "@/components/water/StockGauge";
import { StatusBadge } from "@/components/water/StatusBadge";
import { formatDate, formatDateTime, formatMoney, titleCase } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { useCustomerDeliveries, useCustomerSummary } from "@/lib/queries";
import { supabase } from "@/lib/supabase";
import type { Customer, Delivery, InventoryTransaction } from "@/types/db";
import { AdjustDeliveryDialog, CreditNoteDialog, RecordDeliveryDialog, RecordPaymentDialog, StockMovementDialog } from "./dialogs";

function EditCustomer({ customer }: { customer: Customer }) {
  const qc = useQueryClient();
  const [f, setF] = React.useState({
    price: customer.can_price == null ? "" : String(customer.can_price), low: String(customer.low_stock_threshold),
    critical: String(customer.critical_threshold), safety: String(customer.safety_stock), status: customer.status,
    daily: String(customer.daily_consumption),
  });
  const save = useAction(async () => {
    const { error } = await supabase.from("customers").update({
      can_price: f.price === "" ? null : Number(f.price), low_stock_threshold: Number(f.low), critical_threshold: Number(f.critical),
      safety_stock: Number(f.safety), status: f.status, daily_consumption: Number(f.daily),
    }).eq("id", customer.id);
    if (error) throw error;
  }, { success: "Customer updated", onSuccess: () => qc.invalidateQueries() });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value as never });
  return (
    <Card>
      <CardHeader><CardTitle>Pricing & thresholds</CardTitle></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <Field label="Price/can (₹)" htmlFor="pr" hint="Blank = default"><Input id="pr" type="number" min={0} step="0.5" value={f.price} onChange={set("price")} /></Field>
        <Field label="Low alert at" htmlFor="lo"><Input id="lo" type="number" min={0} value={f.low} onChange={set("low")} /></Field>
        <Field label="Critical at" htmlFor="cr"><Input id="cr" type="number" min={0} value={f.critical} onChange={set("critical")} /></Field>
        <Field label="Safety stock" htmlFor="sa"><Input id="sa" type="number" min={0} value={f.safety} onChange={set("safety")} /></Field>
        <Field label="Cans/day" htmlFor="dy"><Input id="dy" type="number" min={0} value={f.daily} onChange={set("daily")} /></Field>
        <Field label="Status" htmlFor="st"><Select id="st" value={f.status} onChange={set("status")}><option value="active">Active</option><option value="inactive">Inactive</option></Select></Field>
        <Button className="sm:col-span-3" variant="outline" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save changes</Button>
      </CardContent>
    </Card>
  );
}

export default function CustomerDetail() {
  const { id = "" } = useParams();
  const customer = useQuery({ queryKey: ["customer", id], queryFn: async () => {
    const { data, error } = await supabase.from("customers").select("*").eq("id", id).single();
    if (error) throw error;
    return data as Customer;
  } });
  const summary = useCustomerSummary(id);
  const deliveries = useCustomerDeliveries(id);
  const ledger = useQuery({ queryKey: ["ledger", id], queryFn: async () => {
    const { data, error } = await supabase.from("inventory_transactions").select("*").eq("customer_id", id).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    return data as InventoryTransaction[];
  } });
  const [dialog, setDialog] = React.useState<null | "delivery" | "payment" | "movement" | "credit">(null);
  const [adjusting, setAdjusting] = React.useState<Delivery | null>(null);

  if (customer.isLoading || summary.isLoading) return <LoadingState rows={5} />;
  if (customer.error || !customer.data) return <ErrorState error={customer.error} onRetry={customer.refetch} />;
  const c = customer.data;
  const p = summary.data?.prediction;

  return (
    <div className="space-y-5">
      <Link to="/supplier/customers" className="inline-flex items-center gap-1 text-sm text-primary"><ArrowLeft className="h-4 w-4" /> Customers</Link>
      <PageHeader title={c.customer_name} description={`${c.address}${c.phone ? ` · ${c.phone}` : ""}${c.user_id ? "" : " · offline customer"}`}
        actions={<>
          <Button onClick={() => setDialog("delivery")}><Truck /> Delivery</Button>
          <Button variant="outline" onClick={() => setDialog("payment")}><Wallet /> Payment</Button>
          <Button variant="outline" onClick={() => setDialog("movement")}><Boxes /> Stock movement</Button>
          <Button variant="outline" onClick={() => setDialog("credit")}><FileMinus /> Credit note</Button>
        </>} />
      {c.delivery_instructions && <p className="rounded-lg bg-secondary p-3 text-sm"><b>Delivery instructions:</b> {c.delivery_instructions}</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Current stock" value={p?.stock_confirmed ? `${p.current_stock} cans` : "Unconfirmed"} hint={p && <LevelPill level={p.level} />} />
        <StatCard label="Runs out" value={p?.predicted_empty_date ? formatDate(p.predicted_empty_date, "d MMM") : "—"} hint={p?.avg_daily_consumption ? `${p.avg_daily_consumption} cans/day (${p.basis})` : "No usage data"} />
        <StatCard label="Recommended order" value={p?.order_now ? `${p.recommended_order_quantity} cans` : "Not needed"} tone={p?.order_now ? "low" : "ok"} />
        <StatCard label="Balance" value={formatMoney(summary.data?.outstanding_balance)} hint={summary.data && `+ ${formatMoney(summary.data.unbilled.amount)} unbilled`} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Deliveries</CardTitle></CardHeader>
          <Table>
            <THead><TR><TH>Date</TH><TH>Exp</TH><TH>Sent</TH><TH>Confirmed</TH><TH>Status</TH><TH /></TR></THead>
            <TBody>
              {(deliveries.data ?? []).slice(0, 30).map((d) => (
                <TR key={d.id}>
                  <TD>{formatDate(d.delivery_date, "d MMM")}</TD>
                  <TD>{d.expected_quantity}</TD>
                  <TD>{d.actual_quantity}</TD>
                  <TD className={(d.discrepancy ?? 0) < 0 ? "font-semibold text-stock-critical" : ""}>
                    {d.confirmed_quantity ?? "—"}{d.adjusted_quantity ? ` (${d.adjusted_quantity > 0 ? "+" : ""}${d.adjusted_quantity})` : ""}
                  </TD>
                  <TD><StatusBadge status={d.status} /></TD>
                  <TD>{d.status === "confirmed" && <Button variant="ghost" size="icon" aria-label="Adjust delivery" onClick={() => setAdjusting(d)}><Pencil /></Button>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
        <Card>
          <CardHeader><CardTitle>Stock ledger</CardTitle></CardHeader>
          <Table>
            <THead><TR><TH>When</TH><TH>Type</TH><TH className="text-right">Change</TH><TH className="text-right">Balance</TH></TR></THead>
            <TBody>
              {(ledger.data ?? []).map((t) => (
                <TR key={t.id} title={t.notes ?? undefined}>
                  <TD className="text-xs">{formatDateTime(t.created_at)}</TD>
                  <TD>{titleCase(t.transaction_type)}<div className="max-w-[220px] truncate text-xs text-muted-foreground">{t.notes}</div></TD>
                  <TD className={`text-right font-semibold tabular-nums ${t.quantity > 0 ? "text-stock-ok" : t.quantity < 0 ? "text-stock-critical" : ""}`}>{t.quantity > 0 ? `+${t.quantity}` : t.quantity}</TD>
                  <TD className="text-right tabular-nums">{t.balance_after}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
      <EditCustomer customer={c} />
      {dialog === "delivery" && <RecordDeliveryDialog customerId={c.id} onClose={() => setDialog(null)} />}
      {dialog === "payment" && <RecordPaymentDialog customerId={c.id} onClose={() => setDialog(null)} />}
      {dialog === "movement" && <StockMovementDialog customerId={c.id} onClose={() => setDialog(null)} />}
      {dialog === "credit" && <CreditNoteDialog customerId={c.id} onClose={() => setDialog(null)} />}
      {adjusting && <AdjustDeliveryDialog delivery={adjusting} onClose={() => setAdjusting(null)} />}
    </div>
  );
}
