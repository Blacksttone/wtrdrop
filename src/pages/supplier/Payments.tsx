import { Check, Wallet, X } from "lucide-react";
import * as React from "react";
import { useSupplier } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatCard } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { StatusBadge } from "@/components/water/StatusBadge";
import { formatDate, formatMoney, titleCase } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { usePayments } from "@/lib/queries";
import { rpc } from "@/lib/supabase";
import { RecordPaymentDialog } from "./dialogs";

export default function SupplierPayments() {
  const supplier = useSupplier();
  const { data, isLoading, error, refetch } = usePayments({ supplierId: supplier.id });
  const [recording, setRecording] = React.useState(false);
  const verify = useAction((v: { id: string; approve: boolean }) => rpc("verify_payment", { p_payment_id: v.id, p_approve: v.approve, p_note: v.approve ? null : "Payment not found in account" }), {
    success: "Payment updated", invalidate: [["payments"], ["invoices"], ["supplier-dashboard"], ["supplier-customers"]],
  });
  const pending = (data ?? []).filter((p) => p.status === "pending" && p.payment_method !== "online");
  const ok = (data ?? []).filter((p) => p.status === "succeeded");
  const monthStart = new Date().toISOString().slice(0, 8) + "01";

  return (
    <div className="space-y-5">
      <PageHeader title="Payments" description="Cash, UPI and bank payments you record count immediately. Online payments are confirmed by the gateway." actions={<Button onClick={() => setRecording(true)}><Wallet /> Record payment</Button>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Collected this month" value={formatMoney(ok.filter((p) => p.payment_date >= monthStart).reduce((s, p) => s + Number(p.amount), 0))} tone="ok" />
        <StatCard label="To verify" value={pending.length} tone={pending.length ? "low" : "default"} />
        <StatCard label="Payments recorded" value={ok.length} />
      </div>
      {pending.length > 0 && (
        <Card className="border-amber-300">
          <CardHeader><CardTitle>Customer-reported payments to verify</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y">
              {pending.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-semibold">{p.customers?.customer_name} · {formatMoney(p.amount)}</p>
                    <p className="text-sm text-muted-foreground">{titleCase(p.payment_method)} · Ref {p.reference_number ?? "—"} · {formatDate(p.payment_date)}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="success" onClick={() => verify.mutate({ id: p.id, approve: true })}><Check /> Received</Button>
                    <Button size="sm" variant="outline" onClick={() => verify.mutate({ id: p.id, approve: false })}><X /> Not received</Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {isLoading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? (
        <EmptyState icon={Wallet} title="No payments yet" />
      ) : (
        <Card>
          <Table>
            <THead><TR><TH>Date</TH><TH>Customer</TH><TH>Method</TH><TH>Reference</TH><TH className="text-right">Amount</TH><TH>Status</TH></TR></THead>
            <TBody>
              {data.map((p) => (
                <TR key={p.id}>
                  <TD>{formatDate(p.payment_date)}</TD>
                  <TD className="font-medium">{p.customers?.customer_name}</TD>
                  <TD>{titleCase(p.payment_method)}{p.submitted_by_customer && <span className="text-xs text-muted-foreground"> · by customer</span>}</TD>
                  <TD className="text-xs">{p.reference_number ?? "—"}</TD>
                  <TD className="text-right font-semibold">{formatMoney(p.amount)}</TD>
                  <TD><StatusBadge status={p.status} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      {recording && <RecordPaymentDialog onClose={() => setRecording(false)} />}
    </div>
  );
}
