import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, IndianRupee, RefreshCw, Wallet } from "lucide-react";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { EditableSection } from "@/components/ui/editable-section";
import { Field, Input, Switch } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatCard } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatDate, formatMoney } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import type { PlatformInvoiceRow, PlatformPricing } from "@/types/db";

const PRICE_FIELDS: [keyof PlatformPricing, string, string][] = [
  ["home_fee", "Home (per home)", "per month"],
  ["store_branch_fee", "Store (per branch)", "per month"],
  ["company_single_fee", "Company with 1 branch", "per month"],
  ["company_head_fee", "Company 2+ branches: first branch", "per month"],
  ["company_extra_branch_fee", "Company 2+ branches: each other branch", "per month"],
  ["supplier_fee", "Supplier subscription", "per month"],
  ["coworker_fee", "Per supplier co-worker", "per month"],
];

function PricingCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["platform-pricing"],
    queryFn: async () => {
      const { data, error } = await supabase.from("platform_pricing").select("*").single();
      if (error) throw error;
      return data as PlatformPricing;
    },
  });
  const toForm = (p?: PlatformPricing) => Object.fromEntries([
    ...PRICE_FIELDS.map(([k]) => [k, String(p?.[k] ?? "")]),
    ["owner_upi_id", p?.owner_upi_id ?? ""], ["owner_payee_name", p?.owner_payee_name ?? ""],
  ]) as Record<string, string>;
  const [f, setF] = React.useState<Record<string, string>>(toForm());
  const [enabled, setEnabled] = React.useState(true);
  React.useEffect(() => { if (q.data) { setF(toForm(q.data)); setEnabled(q.data.fees_enabled); } }, [q.data]);
  const save = useAction(() => rpc("admin_update_pricing", {
    p: { ...Object.fromEntries(PRICE_FIELDS.map(([k]) => [k, Number(f[k])])), fees_enabled: enabled,
         owner_upi_id: f.owner_upi_id, owner_payee_name: f.owner_payee_name },
  }), { success: "Prices saved", onSuccess: () => qc.invalidateQueries({ queryKey: ["platform-pricing"] }) });
  if (q.isLoading) return <LoadingState rows={2} />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  return (
    <EditableSection title="Prices" description="Changes apply to bills created from now on. The month someone joins is always free."
      onSave={() => save.mutateAsync(undefined)} onCancel={() => { setF(toForm(q.data)); setEnabled(q.data!.fees_enabled); }} saving={save.isPending}>
      <div className="flex items-center justify-between rounded-xl bg-secondary p-3">
        <div><p className="text-sm font-semibold">Charge service fees</p><p className="text-xs text-muted-foreground">Switch off to stop all new fees.</p></div>
        <Switch id="fees-on" label="Charge service fees" checked={enabled} onChange={setEnabled} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {PRICE_FIELDS.map(([k, label, hint]) => (
          <Field key={k} label={`${label} (₹)`} htmlFor={`pr-${k}`} hint={hint}>
            <Input id={`pr-${k}`} type="number" min={0} step="1" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Your UPI ID (suppliers pay you here)" htmlFor="pr-upi"><Input id="pr-upi" placeholder="yourname@okaxis" value={f.owner_upi_id} onChange={(e) => setF({ ...f, owner_upi_id: e.target.value })} /></Field>
        <Field label="Payee name" htmlFor="pr-name"><Input id="pr-name" placeholder="Waterdrop" value={f.owner_payee_name} onChange={(e) => setF({ ...f, owner_payee_name: e.target.value })} /></Field>
      </div>
    </EditableSection>
  );
}

function MarkPaidDialog({ row, onClose }: { row: PlatformInvoiceRow; onClose: () => void }) {
  const [ref, setRef] = React.useState("");
  const mark = useAction((status: string) => rpc("admin_set_platform_invoice_status", { p_invoice_id: row.invoice_id, p_status: status, p_reference: ref || null }), {
    success: "Updated", invalidate: [["platform-earnings"]], onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`${row.business_name} · ${formatDate(row.month, "MMM yyyy")}`} description={`Total ${formatMoney(row.total)}`}>
        <div className="space-y-4">
          <Field label="Payment reference (UPI / bank)" htmlFor="pi-ref"><Input id="pi-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. UPI ref 4123…" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" loading={mark.isPending} onClick={() => mark.mutate("waived")}>Waive</Button>
            <Button variant="success" loading={mark.isPending} onClick={() => mark.mutate("paid")}><CheckCircle2 /> Mark paid</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminEarnings() {
  const [month, setMonth] = React.useState("");
  const [paying, setPaying] = React.useState<PlatformInvoiceRow | null>(null);
  const list = useQuery({
    queryKey: ["platform-earnings", month],
    queryFn: () => rpc<PlatformInvoiceRow[]>("admin_platform_earnings", { p_month: month ? `${month}-01` : null }),
  });
  const thisMonth = new Date().toISOString().slice(0, 7);
  const refresh = useAction(() => rpc<number>("admin_generate_platform_invoices", { p_month: `${month || thisMonth}-01` }), {
    success: (n) => `Bills refreshed for ${n} supplier${n === 1 ? "" : "s"}`, invalidate: [["platform-earnings"]],
  });
  const rows = list.data ?? [];
  const sum = (pred: (r: PlatformInvoiceRow) => boolean) => rows.filter(pred).reduce((t, r) => t + Number(r.total), 0);
  return (
    <div className="space-y-5">
      <PageHeader title="Earnings" description="Your Waterdrop service fees: supplier subscriptions, co-workers and customer fees."
        actions={<Button variant="outline" loading={refresh.isPending} onClick={() => refresh.mutate(undefined)}><RefreshCw /> Refresh {month ? "" : "this month's "}bills</Button>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Collected" value={formatMoney(sum((r) => r.status === "paid"))} icon={Wallet} tone="ok" />
        <StatCard label="Unpaid" value={formatMoney(sum((r) => r.status === "unpaid"))} icon={IndianRupee} tone={sum((r) => r.status === "unpaid") > 0 ? "low" : "default"} />
        <StatCard label="Customer fees in bills" value={formatMoney(rows.reduce((t, r) => t + Number(r.customer_fees), 0))} />
      </div>
      <PricingCard />
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div><CardTitle>Supplier Waterdrop bills</CardTitle><CardDescription>Created on the 1st of every month for the month before.</CardDescription></div>
          <Input aria-label="Month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" />
        </CardHeader>
        <CardContent>
          {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={list.refetch} /> : !rows.length ? (
            <EmptyState icon={IndianRupee} title="No bills yet" description="Bills appear on the 1st of next month. Tap Refresh to create this month's bills now." />
          ) : (
            <Table>
              <THead><TR><TH>Supplier</TH><TH>Month</TH><TH>Subscription</TH><TH>Co-workers</TH><TH>Customer fees</TH><TH className="text-right">Total</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.invoice_id}>
                    <TD className="font-medium">{r.business_name}</TD>
                    <TD>{formatDate(r.month, "MMM yyyy")}</TD>
                    <TD>{formatMoney(r.subscription_fee)}</TD>
                    <TD>{r.coworkers} · {formatMoney(r.coworker_fee)}</TD>
                    <TD>{formatMoney(r.customer_fees)}</TD>
                    <TD className="text-right font-semibold">{formatMoney(r.total)}</TD>
                    <TD>{r.status === "paid" ? <Badge variant="success">paid</Badge> : r.status === "waived" ? <Badge variant="muted">waived</Badge> : <Badge variant="danger">unpaid · due {formatDate(r.due_date, "d MMM")}</Badge>}</TD>
                    <TD>{r.status === "unpaid" && <Button size="sm" variant="outline" onClick={() => setPaying(r)}>Mark paid</Button>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {paying && <MarkPaidDialog row={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}
