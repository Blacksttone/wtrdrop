import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Download, FileText, Share2, Wallet } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useCustomer } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { StatusBadge } from "@/components/water/StatusBadge";
import { errorMessage } from "@/lib/errors";
import { formatDate, formatMoney, titleCase } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { downloadInvoice, shareInvoice } from "@/lib/pdf/invoice";
import { fetchInvoiceItems, useCustomerSummary, useInvoices, usePayments } from "@/lib/queries";
import { rpc, supabase } from "@/lib/supabase";
import type { Invoice, InvoiceItem } from "@/types/db";
import { payOnline, paymentGatewayEnabled } from "./payOnline";

export function InvoiceDetail({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const items = useQuery({ queryKey: ["invoice-items", invoice.id], queryFn: () => fetchInvoiceItems(invoice.id) });
  const [busy, setBusy] = React.useState(false);
  const run = async (fn: (i: Invoice, items: InvoiceItem[]) => Promise<unknown>) => {
    setBusy(true);
    try { await fn(invoice, items.data ?? []); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const outstanding = Math.max(Number(invoice.amount_due) - Number(invoice.amount_paid), 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Bill ${invoice.invoice_number}`} description={`${formatDate(invoice.billing_period_start)} – ${formatDate(invoice.billing_period_end)}`} className="sm:max-w-2xl">
        <div className="flex items-center justify-between"><StatusBadge status={invoice.status} /><span className="text-sm text-muted-foreground">Due {formatDate(invoice.due_date)}</span></div>
        {items.isLoading ? <LoadingState rows={2} /> : (
          <ul className="mt-4 divide-y rounded-lg border text-sm">
            {(items.data ?? []).map((it) => (
              <li key={it.id} className="flex justify-between gap-3 p-3">
                <div><p className="font-medium">{formatDate(it.item_date, "d MMM")}</p><p className="text-xs text-muted-foreground">{it.description}</p></div>
                <div className="text-right"><p>{it.quantity} × {formatMoney(it.unit_price)}</p><p className="font-semibold">{formatMoney(it.amount)}</p></div>
              </li>
            ))}
            {!items.data?.length && <li className="p-3 text-muted-foreground">No deliveries in this period.</li>}
          </ul>
        )}
        <dl className="mt-4 space-y-1.5 text-sm">
          {[
            ["Delivered cans", `${invoice.total_quantity}`],
            ["This period", formatMoney(invoice.subtotal)],
            ...(Number(invoice.tax_amount) > 0 ? [[`Tax (${invoice.tax_rate}%)`, formatMoney(invoice.tax_amount)]] : []),
            ["Previous balance", formatMoney(invoice.previous_balance)],
            ["Payments received", `− ${formatMoney(invoice.payments_received)}`],
            ...(Number(invoice.credits) > 0 ? [["Credits", `− ${formatMoney(invoice.credits)}`]] : []),
          ].map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>)}
          <div className="flex justify-between border-t pt-2 text-base font-bold"><dt>Amount due</dt><dd>{formatMoney(invoice.amount_due)}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Paid since bill</dt><dd>{formatMoney(invoice.amount_paid)}</dd></div>
          <div className="flex justify-between font-semibold text-amber-700"><dt>Outstanding</dt><dd>{formatMoney(outstanding)}</dd></div>
        </dl>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button variant="outline" loading={busy} onClick={() => run(downloadInvoice)}><Download /> Download PDF</Button>
          <Button variant="outline" loading={busy} onClick={() => run(shareInvoice)}><Share2 /> Share</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PayDialog({ outstanding, invoiceId, onClose }: { outstanding: number; invoiceId?: string; onClose: () => void }) {
  const customer = useCustomer();
  const qc = useQueryClient();
  const [amount, setAmount] = React.useState(outstanding > 0 ? outstanding.toFixed(2) : "");
  const [method, setMethod] = React.useState<"upi" | "bank_transfer" | "cash">("upi");
  const [ref, setRef] = React.useState("");
  const [online, setOnline] = React.useState(false);
  const submit = useAction(
    () => rpc("submit_payment", { p_customer_id: customer.id, p_amount: Number(amount), p_method: method, p_reference: ref || null, p_invoice_id: invoiceId ?? null }),
    { success: "Payment submitted. Your supplier will verify it.", onSuccess: () => { qc.invalidateQueries(); onClose(); } },
  );
  const supplierInfo = useQuery({
    queryKey: ["supplier-public", customer.supplier_id],
    queryFn: async () => (await supabase.from("suppliers").select("business_name, billing_info").eq("id", customer.supplier_id).single()).data,
  });
  const upi = (supplierInfo.data?.billing_info as { upi_id?: string } | undefined)?.upi_id;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Pay your water bill" description={`Outstanding ${formatMoney(outstanding)}`}>
        <Field label="Amount (₹)" htmlFor="amt"><Input id="amt" type="number" min={1} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        {paymentGatewayEnabled && (
          <Button className="mt-4 w-full" size="lg" loading={online} onClick={async () => {
            setOnline(true);
            try { await payOnline(customer.id, Number(amount)); qc.invalidateQueries(); onClose(); } catch (e) { toast.error(errorMessage(e)); } finally { setOnline(false); }
          }}><CreditCard /> Pay online now</Button>
        )}
        <div className="mt-5 rounded-xl border p-4">
          <p className="text-sm font-semibold">Already paid another way?</p>
          {upi && <p className="mt-1 text-xs text-muted-foreground">Supplier UPI: <b className="select-all text-foreground">{upi}</b></p>}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Method" htmlFor="m">
              <Select id="m" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option>
              </Select>
            </Field>
            <Field label={method === "cash" ? "Note (optional)" : "Transaction reference"} htmlFor="ref"><Input id="ref" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          </div>
          <Button variant="outline" className="mt-3 w-full" loading={submit.isPending} onClick={() => submit.mutate(undefined)}>Submit for verification</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function BillsPage() {
  const customer = useCustomer();
  const summary = useCustomerSummary(customer.id);
  const { data, isLoading, error, refetch } = useInvoices({ customerId: customer.id });
  const [open, setOpen] = React.useState<Invoice | null>(null);
  const [paying, setPaying] = React.useState(false);
  const outstanding = Math.max(Number(summary.data?.outstanding_balance ?? 0), 0);
  return (
    <div className="space-y-4">
      <PageHeader title="Bills & payments" description="Bills are based only on deliveries you confirmed." />
      <Card className="water-gradient border-0 text-white">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <p className="text-sm text-sky-100">Outstanding balance</p>
            <p className="text-3xl font-extrabold">{formatMoney(outstanding)}</p>
            {summary.data && Number(summary.data.unbilled.amount) > 0 && (
              <p className="text-xs text-sky-100">+ {formatMoney(summary.data.unbilled.amount)} for {summary.data.unbilled.quantity} cans this month (billed next cycle)</p>
            )}
            {Number(summary.data?.outstanding_balance ?? 0) < 0 && <p className="text-xs text-sky-100">You have {formatMoney(-Number(summary.data?.outstanding_balance))} advance credit.</p>}
          </div>
          <Button className="bg-white text-primary hover:bg-sky-50" size="lg" onClick={() => setPaying(true)}><Wallet /> Pay now</Button>
        </CardContent>
      </Card>
      {isLoading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? (
        <EmptyState icon={FileText} title="No bills yet" description="Your monthly bill appears here at the start of each billing cycle." />
      ) : (
        <div className="space-y-2">
          {data.map((inv) => (
            <button key={inv.id} onClick={() => setOpen(inv)} className="w-full text-left">
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-3 p-4">
                  <FileText className="h-8 w-8 rounded-lg bg-secondary p-1.5 text-primary" />
                  <div className="flex-1">
                    <p className="font-semibold">{formatDate(inv.billing_period_start, "MMM yyyy")} · {inv.total_quantity} cans</p>
                    <p className="text-xs text-muted-foreground">{inv.invoice_number} · due {formatDate(inv.due_date)}</p>
                  </div>
                  <div className="text-right"><p className="font-bold">{formatMoney(inv.amount_due)}</p><StatusBadge status={inv.status} /></div>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}
      <PaymentHistory />
      {open && <InvoiceDetail invoice={open} onClose={() => setOpen(null)} />}
      {paying && <PayDialog outstanding={outstanding} invoiceId={data?.[0]?.id} onClose={() => setPaying(false)} />}
    </div>
  );
}

export function PaymentHistory() {
  const customer = useCustomer();
  const { data, isLoading } = usePayments({ customerId: customer.id });
  return (
    <Card>
      <CardHeader><CardTitle>Payment history</CardTitle></CardHeader>
      <CardContent>
        {isLoading ? <LoadingState rows={2} /> : !data?.length ? <p className="text-sm text-muted-foreground">No payments yet.</p> : (
          <ul className="divide-y">
            {data.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2.5">
                <div>
                  <p className="font-medium">{formatMoney(p.amount)} <span className="text-xs font-normal text-muted-foreground">· {titleCase(p.payment_method)}</span></p>
                  <p className="text-xs text-muted-foreground">{formatDate(p.payment_date)}{p.reference_number ? ` · Ref ${p.reference_number}` : ""}</p>
                </div>
                <StatusBadge status={p.status} label={p.status === "pending" ? "Verifying" : undefined} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
