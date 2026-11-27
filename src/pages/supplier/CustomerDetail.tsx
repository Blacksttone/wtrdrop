import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Boxes, FileMinus, Lock, Pencil, Truck, Unlock, Wallet } from "lucide-react";
import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { useCanManage } from "@/auth/AuthProvider";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { householdLabel } from "@/lib/household";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ErrorState, LoadingState, PageHeader, StatCard } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LevelPill } from "@/components/water/StockGauge";
import { StatusBadge } from "@/components/water/StatusBadge";
import { formatDate, formatDateTime, formatMoney, titleCase } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { LocationCard } from "@/components/water/LocationControls";
import { CansWithCustomerCard, EditEmptyCans } from "@/components/water/CanControls";
import { useCustomerDeliveries, useCustomerSummary } from "@/lib/queries";
import { rpc, supabase } from "@/lib/supabase";
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

function BlockDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = React.useState("");
  const block = useAction(() => rpc("set_customer_blocked", { p_customer_id: customer.id, p_blocked: true, p_reason: reason }), {
    success: `${customer.customer_name} blocked`, onSuccess: () => { qc.invalidateQueries(); onClose(); },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Block ${customer.customer_name}?`} description="They will not be able to order, confirm deliveries or use the app until you unblock them. Their stock and bills are kept.">
        <Field label="Reason (shown to the customer)" htmlFor="br"><Textarea id="br" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Bill unpaid for 3 months" /></Field>
        <Button variant="destructive" className="mt-4 w-full" disabled={reason.trim().length < 3} loading={block.isPending} onClick={() => block.mutate(undefined)}><Lock /> Block customer</Button>
      </DialogContent>
    </Dialog>
  );
}

/** Other accounts of the same person with this supplier (e.g. their company and their home): billed separately. */
function SameOwner({ customer }: { customer: Customer }) {
  const others = useQuery({
    queryKey: ["same-owner", customer.id], enabled: Boolean(customer.user_id),
    queryFn: async () => {
      const { data, error } = await supabase.from("customers").select("id, customer_name, branch_name, account_id, customer_accounts(name, account_type)")
        .eq("user_id", customer.user_id!).neq("id", customer.id);
      if (error) throw error;
      return (data ?? []) as unknown as { id: string; customer_name: string; branch_name: string | null; account_id: string | null; customer_accounts: { name: string; account_type: string } | null }[];
    },
  });
  const rows = (others.data ?? []).filter((o) => o.account_id !== customer.account_id);
  if (!rows.length) return null;
  return (
    <p className="rounded-lg border bg-card p-3 text-sm">
      <b>Same owner also has:</b>{" "}
      {rows.map((o, i) => (
        <span key={o.id}>{i > 0 && ", "}<Link className="text-primary underline" to={`/supplier/customers/${o.id}`}>
          {o.customer_accounts?.name ?? o.customer_name}{o.branch_name ? ` · ${o.branch_name}` : ""} ({o.customer_accounts?.account_type ?? "home"})
        </Link></span>
      ))}
      <span className="text-muted-foreground"> — billed separately.</span>
    </p>
  );
}

export default function CustomerDetail() {
  const { id = "" } = useParams();
  const customer = useQuery({ queryKey: ["customer", id], queryFn: async () => {
    const { data, error } = await supabase.from("customers").select("*, customer_accounts(name, account_type)").eq("id", id).single();
    if (error) throw error;
    return data as Customer & { customer_accounts: { name: string; account_type: string } | null };
  } });
  const summary = useCustomerSummary(id);
  const deliveries = useCustomerDeliveries(id);
  const ledger = useQuery({ queryKey: ["ledger", id], queryFn: async () => {
    const { data, error } = await supabase.from("inventory_transactions").select("*").eq("customer_id", id).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    return data as InventoryTransaction[];
  } });
  const canManage = useCanManage();
  const qc = useQueryClient();
  const [dialog, setDialog] = React.useState<null | "delivery" | "payment" | "movement" | "credit" | "block">(null);
  const unblock = useAction((id: string) => rpc("set_customer_blocked", { p_customer_id: id, p_blocked: false }), {
    success: "Customer unblocked", onSuccess: () => qc.invalidateQueries(),
  });
  const [adjusting, setAdjusting] = React.useState<Delivery | null>(null);

  if (customer.isLoading || summary.isLoading) return <LoadingState rows={5} />;
  if (customer.error || !customer.data) return <ErrorState error={customer.error} onRetry={customer.refetch} />;
  const c = customer.data;
  const p = summary.data?.prediction;

  return (
    <div className="space-y-5">
      <Link to="/supplier/customers" className="inline-flex items-center gap-1 text-sm text-primary"><ArrowLeft className="h-4 w-4" /> Customers</Link>
      <PageHeader
        title={c.customer_accounts && c.customer_accounts.account_type !== "home" ? `${c.customer_accounts.name}${c.branch_name ? ` · ${c.branch_name}` : ""}` : c.customer_name}
        description={`${c.customer_accounts ? `${c.customer_accounts.account_type[0].toUpperCase()}${c.customer_accounts.account_type.slice(1)} · contact ${c.customer_name} · ` : ""}${c.address}${c.phone ? ` · ${c.phone}` : ""}${c.user_id || c.account_id ? "" : " · offline customer"}${c.bill_to_customer_id ? " · billed on the head branch's combined bill" : ""}`}
        actions={<>
          <Button onClick={() => setDialog("delivery")}><Truck /> Delivery</Button>
          {canManage && <>
            <Button variant="outline" onClick={() => setDialog("payment")}><Wallet /> Payment</Button>
            <Button variant="outline" onClick={() => setDialog("movement")}><Boxes /> Stock movement</Button>
            <Button variant="outline" onClick={() => setDialog("credit")}><FileMinus /> Credit note</Button>
            {c.blocked_at
              ? <Button variant="success" loading={unblock.isPending} onClick={() => unblock.mutate(c.id)}><Unlock /> Unblock</Button>
              : <Button variant="outline" className="text-destructive" onClick={() => setDialog("block")}><Lock /> Block</Button>}
          </>}
        </>} />
      {c.blocked_at && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><b>Blocked</b> on {formatDate(c.blocked_at)} — {c.block_reason}</p>
      )}
      <p className="text-sm text-muted-foreground">Household: <b className="text-foreground">{householdLabel(c.household_type)}</b>{c.members_count ? ` · ${c.members_count} members` : ""}</p>
      {c.delivery_instructions && <p className="rounded-lg bg-secondary p-3 text-sm"><b>Delivery instructions:</b> {c.delivery_instructions}</p>}
      <SameOwner customer={c} />
      <LocationCard customer={c} forSupplier />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Current stock" value={p?.stock_confirmed ? `${p.current_stock} cans` : "Unconfirmed"} hint={p && <LevelPill level={p.level} />} />
        <StatCard label="Runs out" value={p?.predicted_empty_date ? formatDate(p.predicted_empty_date, "d MMM") : "—"} hint={p?.avg_daily_consumption ? `${p.avg_daily_consumption} cans/day (${p.basis})` : "No usage data"} />
        <StatCard label="Recommended order" value={p?.order_now ? `${p.recommended_order_quantity} cans` : "Not needed"} tone={p?.order_now ? "low" : "ok"} />
        <CansWithCustomerCard customerId={c.id} canCorrect={canManage} />
        {canManage && <StatCard label="Balance" value={formatMoney(summary.data?.outstanding_balance)} hint={summary.data && `+ ${formatMoney(summary.data.unbilled.amount)} unbilled`} />}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Deliveries</CardTitle></CardHeader>
          <Table>
            <THead><TR><TH>Date</TH><TH>Exp</TH><TH>Sent</TH><TH>Empty</TH><TH>Confirmed</TH><TH>Status</TH><TH /></TR></THead>
            <TBody>
              {(deliveries.data ?? []).slice(0, 30).map((d) => (
                <TR key={d.id}>
                  <TD>{formatDate(d.delivery_date, "d MMM")}</TD>
                  <TD>{d.expected_quantity}</TD>
                  <TD>{d.actual_quantity}</TD>
                  <TD><EditEmptyCans delivery={d} /></TD>
                  <TD className={(d.discrepancy ?? 0) < 0 ? "font-semibold text-stock-critical" : ""}>
                    {d.confirmed_quantity ?? "—"}{d.adjusted_quantity ? ` (${d.adjusted_quantity > 0 ? "+" : ""}${d.adjusted_quantity})` : ""}
                  </TD>
                  <TD><StatusBadge status={d.status} /></TD>
                  <TD>{canManage && d.status === "confirmed" && <Button variant="ghost" size="icon" aria-label="Adjust delivery" onClick={() => setAdjusting(d)}><Pencil /></Button>}</TD>
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
      {canManage && <EditCustomer customer={c} />}
      {dialog === "delivery" && <RecordDeliveryDialog customerId={c.id} onClose={() => setDialog(null)} />}
      {dialog === "payment" && <RecordPaymentDialog customerId={c.id} onClose={() => setDialog(null)} />}
      {dialog === "movement" && <StockMovementDialog customerId={c.id} onClose={() => setDialog(null)} />}
      {dialog === "credit" && <CreditNoteDialog customerId={c.id} onClose={() => setDialog(null)} />}
      {adjusting && <AdjustDeliveryDialog delivery={adjusting} onClose={() => setAdjusting(null)} />}
      {dialog === "block" && <BlockDialog customer={c} onClose={() => setDialog(null)} />}
    </div>
  );
}
