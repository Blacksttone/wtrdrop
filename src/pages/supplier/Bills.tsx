import { FileText, PlayCircle } from "lucide-react";
import * as React from "react";
import { useSupplier } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatCard } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { StatusBadge } from "@/components/water/StatusBadge";
import { billingPeriodFor } from "@/lib/domain/billing";
import { formatDate, formatMoney, todayISO } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { useInvoices, useSupplierSettings } from "@/lib/queries";
import { rpc } from "@/lib/supabase";
import type { Invoice } from "@/types/db";
import { InvoiceDetail } from "../customer/Bills";

export default function SupplierBills() {
  const supplier = useSupplier();
  const settings = useSupplierSettings(supplier.id);
  const { data, isLoading, error, refetch } = useInvoices({ supplierId: supplier.id });
  const [open, setOpen] = React.useState<Invoice | null>(null);
  const [status, setStatus] = React.useState("all");
  const [custom, setCustom] = React.useState({ start: "", end: "" });
  const period = settings.data ? billingPeriodFor(settings.data.billing_day, todayISO()) : null;
  const run = useAction((p: { start?: string; end?: string }) => rpc<{ created: number; failed?: number }>("run_my_billing", { p_period_start: p.start ?? null, p_period_end: p.end ?? null }), {
    success: (r) => (r.created ? `${r.created} new bill${r.created === 1 ? "" : "s"} generated` : "All bills for this period already exist — nothing new to bill"),
    invalidate: [["invoices"], ["supplier-dashboard"]],
  });
  const rows = (data ?? []).filter((i) => status === "all" || i.status === status);
  const latest = (data ?? []).filter((i) => !i.superseded_by);

  return (
    <div className="space-y-5">
      <PageHeader title="Monthly bills" description="Generated automatically on your billing day from customer-confirmed deliveries." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open bills" value={latest.filter((i) => i.status !== "paid").length} />
        <StatCard label="Overdue" value={latest.filter((i) => i.status === "overdue").length} tone="critical" />
        <StatCard label="Billed (latest)" value={formatMoney(latest.reduce((s, i) => s + Number(i.current_charges), 0))} />
        <StatCard label="Outstanding (latest)" value={formatMoney(latest.reduce((s, i) => s + Math.max(Number(i.amount_due) - Number(i.amount_paid), 0), 0))} tone="low" />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Generate bills</CardTitle>
          <CardDescription>Safe to run any time — each customer gets at most one bill per period, and each delivery is billed exactly once.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="flex-1">
            <p className="text-sm">Last completed cycle: <b>{period ? `${formatDate(period.start)} – ${formatDate(period.end)}` : "…"}</b> (billing day {settings.data?.billing_day})</p>
            <Button className="mt-2" loading={run.isPending && !run.variables?.start} onClick={() => run.mutate({})}><PlayCircle /> Generate for this cycle</Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Custom start" htmlFor="cs"><Input id="cs" type="date" value={custom.start} onChange={(e) => setCustom({ ...custom, start: e.target.value })} /></Field>
            <Field label="Custom end" htmlFor="ce"><Input id="ce" type="date" max={todayISO()} value={custom.end} onChange={(e) => setCustom({ ...custom, end: e.target.value })} /></Field>
            <Button variant="outline" disabled={!custom.start || !custom.end} loading={run.isPending && Boolean(run.variables?.start)} onClick={() => run.mutate(custom)}>Generate custom</Button>
          </div>
        </CardContent>
      </Card>
      <div className="max-w-xs">
        <Select aria-label="Filter status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All bills</option><option value="unpaid">Unpaid</option><option value="partially_paid">Partially paid</option><option value="overdue">Overdue</option><option value="paid">Paid</option>
        </Select>
      </div>
      {isLoading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={refetch} /> : !rows.length ? (
        <EmptyState icon={FileText} title="No bills" description="Bills appear after your first billing cycle completes." />
      ) : (
        <Card>
          <Table>
            <THead><TR><TH>Invoice</TH><TH>Customer</TH><TH>Period</TH><TH>Cans</TH><TH className="text-right">Charges</TH><TH className="text-right">Due</TH><TH className="text-right">Paid</TH><TH>Status</TH></TR></THead>
            <TBody>
              {rows.map((i) => (
                <TR key={i.id} className="cursor-pointer" onClick={() => setOpen(i)}>
                  <TD className="font-medium text-primary">{i.invoice_number}{i.superseded_by && <span className="ml-1 text-xs text-muted-foreground">(carried forward)</span>}</TD>
                  <TD>{i.customers?.customer_name}</TD>
                  <TD>{formatDate(i.billing_period_start, "d MMM")} – {formatDate(i.billing_period_end, "d MMM")}</TD>
                  <TD>{i.total_quantity}</TD>
                  <TD className="text-right">{formatMoney(i.current_charges)}</TD>
                  <TD className="text-right font-semibold">{formatMoney(i.amount_due)}</TD>
                  <TD className="text-right">{formatMoney(i.amount_paid)}</TD>
                  <TD><StatusBadge status={i.status} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      {open && <InvoiceDetail invoice={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
