import { useQuery } from "@tanstack/react-query";
import { Copy, IndianRupee, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatCard } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatDate, formatMoney } from "@/lib/format";
import { openExternal } from "@/lib/native";
import { rpc, supabase } from "@/lib/supabase";
import type { PlatformInvoice, PlatformSummary } from "@/types/db";

export function upiPayUrl(upi: string, name: string | null, amount: number, note: string) {
  const q = new URLSearchParams({ pa: upi, pn: name || "Waterdrop", am: amount.toFixed(2), cu: "INR", tn: note });
  return `upi://pay?${q.toString()}`;
}

/** Supplier's monthly bill from the app owner (subscription, co-workers, customer service fees). */
export default function WaterdropBill() {
  const summary = useQuery({ queryKey: ["platform-summary"], queryFn: () => rpc<PlatformSummary>("my_platform_summary") });
  const bills = useQuery({
    queryKey: ["platform-invoices"],
    queryFn: async () => {
      const { data, error } = await supabase.from("platform_invoices").select("*").order("month", { ascending: false }).limit(24);
      if (error) throw error;
      return data as PlatformInvoice[];
    },
  });
  if (summary.isLoading) return <LoadingState rows={4} />;
  if (summary.error || !summary.data) return <ErrorState error={summary.error} onRetry={summary.refetch} />;
  const s = summary.data;
  const pay = (b: PlatformInvoice) => {
    if (!s.pay_to.upi_id) return toast.error("Payment details are not set yet. Please contact Waterdrop support.");
    openExternal(upiPayUrl(s.pay_to.upi_id, s.pay_to.name, Number(b.total), b.invoice_number));
  };
  return (
    <div className="space-y-5">
      <PageHeader title="Waterdrop bill" description="Your monthly fee for using Waterdrop." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Unpaid" value={formatMoney(s.unpaid_total)} icon={IndianRupee} tone={Number(s.unpaid_total) > 0 ? "low" : "ok"} />
        <StatCard label={`This month (${formatDate(s.month, "MMM")}) so far`} value={formatMoney(s.estimate)} hint={s.free_month ? "Subscription free this month" : undefined} />
        <StatCard label="Co-workers" value={s.coworkers} hint={`${formatMoney(s.prices.coworker)} each per month`} />
        <StatCard label="Customer service fees" value={formatMoney(s.customer_fees_so_far)} hint="On bills issued this month" />
      </div>
      <Card>
        <CardHeader><CardTitle>How it works</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>• Subscription <b>{formatMoney(s.prices.supplier)}</b> a month + <b>{formatMoney(s.prices.coworker)}</b> for each co-worker. The month you joined is free.</p>
          <p>• Your customers' bills include a Waterdrop service fee: Home {formatMoney(s.prices.home)}, Store {formatMoney(s.prices.store_branch)} per branch,
            Company {formatMoney(s.prices.company_single)} (1 branch) or {formatMoney(s.prices.company_head)} + {formatMoney(s.prices.company_extra_branch)} per extra branch.
            You collect it with your bill and pass it on here. A customer's first month is free.</p>
          <p>• Your bill for each month is ready on the 1st of the next month and is due by the 10th.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Bills</CardTitle><CardDescription>Pay with any UPI app. Waterdrop marks it paid after checking.</CardDescription></CardHeader>
        <CardContent>
          {bills.isLoading ? <LoadingState /> : !bills.data?.length ? (
            <EmptyState icon={IndianRupee} title="No bills yet" description="Your first bill appears on the 1st of next month." />
          ) : (
            <Table>
              <THead><TR><TH>Month</TH><TH>Subscription</TH><TH>Co-workers</TH><TH>Customer fees</TH><TH className="text-right">Total</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {bills.data.map((b) => (
                  <TR key={b.id}>
                    <TD>{formatDate(b.month, "MMM yyyy")}<div className="text-xs text-muted-foreground">{b.invoice_number}</div></TD>
                    <TD>{formatMoney(b.subscription_fee)}</TD>
                    <TD>{b.coworkers} · {formatMoney(b.coworker_fee)}</TD>
                    <TD>{formatMoney(b.customer_fees)}</TD>
                    <TD className="text-right font-semibold">{formatMoney(b.total)}</TD>
                    <TD>{b.status === "paid" ? <Badge variant="success">paid</Badge> : b.status === "waived" ? <Badge variant="muted">no charge</Badge> : <Badge variant="danger">due {formatDate(b.due_date, "d MMM")}</Badge>}</TD>
                    <TD>{b.status === "unpaid" && <Button size="sm" onClick={() => pay(b)}><Smartphone /> Pay with UPI</Button>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {s.pay_to.upi_id && (
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              UPI: <b className="text-foreground">{s.pay_to.upi_id}</b>
              <button type="button" aria-label="Copy UPI ID" onClick={async () => { await navigator.clipboard.writeText(s.pay_to.upi_id!); toast.success("UPI ID copied"); }}><Copy className="h-3 w-3" /></button>
              · Put the bill number in the payment note.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
