import { useQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useSupplier } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState, PageHeader, StatCard } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LevelPill } from "@/components/water/StockGauge";
import { formatDate } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import type { CorrectionRequest } from "@/types/db";
import { useCustomerList } from "./dialogs";

export default function Inventory() {
  const supplier = useSupplier();
  const { data, isLoading, error, refetch } = useCustomerList();
  const requests = useQuery({
    queryKey: ["correction-requests", supplier.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("stock_correction_requests").select("*, customers(customer_name)").eq("supplier_id", supplier.id).eq("status", "pending").order("created_at");
      if (error) throw error;
      return data as CorrectionRequest[];
    },
  });
  const resolve = useAction((v: { id: string; approve: boolean }) => rpc("resolve_correction_request", { p_request_id: v.id, p_approve: v.approve }), {
    success: "Request resolved", invalidate: [["correction-requests"], ["supplier-customers"]],
  });
  const rows = [...(data ?? [])].filter((c) => c.status === "active").sort((a, b) => {
    const rank = { critical: 0, low: 1, unknown: 2, ok: 3 };
    return rank[a.level] - rank[b.level] || a.current_stock - b.current_stock;
  });
  const total = rows.reduce((s, c) => s + c.current_stock, 0);
  const daily = rows.reduce((s, c) => s + c.daily_consumption, 0);

  return (
    <div className="space-y-5">
      <PageHeader title="Inventory" description="Water cans at each customer, based on confirmed deliveries and recorded usage." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Cans at customers" value={total} />
        <StatCard label="Expected daily use" value={`${daily} cans`} />
        <StatCard label="Critical" value={rows.filter((c) => c.level === "critical").length} tone="critical" />
        <StatCard label="Low" value={rows.filter((c) => c.level === "low").length} tone="low" />
      </div>
      {(requests.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader><CardTitle>Consumption correction requests</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y">
              {requests.data!.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium">{r.customers?.customer_name} · {formatDate(r.consumption_date)}</p>
                    <p className="text-sm text-muted-foreground">{r.current_quantity} → {r.requested_quantity} cans · “{r.reason}”</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="success" onClick={() => resolve.mutate({ id: r.id, approve: true })}><Check /> Approve</Button>
                    <Button size="sm" variant="outline" onClick={() => resolve.mutate({ id: r.id, approve: false })}><X /> Decline</Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {isLoading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={refetch} /> : (
        <Card>
          <Table>
            <THead><TR><TH>Customer</TH><TH>Stock</TH><TH>Level</TH><TH>Use/day</TH><TH>Predicted empty</TH></TR></THead>
            <TBody>
              {rows.map((c) => (
                <TR key={c.id}>
                  <TD><Link to={`/supplier/customers/${c.id}`} className="font-medium text-primary hover:underline">{c.customer_name}</Link></TD>
                  <TD className="font-bold tabular-nums">{c.stock_confirmed ? c.current_stock : "?"}</TD>
                  <TD><LevelPill level={c.level} /></TD>
                  <TD>{c.daily_consumption}</TD>
                  <TD>{formatDate(c.predicted_empty_date, "EEE d MMM")}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
