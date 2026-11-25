import { useQueryClient } from "@tanstack/react-query";
import { addDays, format, parseISO } from "date-fns";
import { Droplets, Pencil } from "lucide-react";
import * as React from "react";
import { useCustomer } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { formatDate } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { useConsumption, useCustomerSummary } from "@/lib/queries";
import { rpc } from "@/lib/supabase";
import { QuickConsumption } from "./QuickConsumption";

function EditDay({ date, current, editable, onClose }: { date: string; current: number; editable: boolean; onClose: () => void }) {
  const customer = useCustomer();
  const qc = useQueryClient();
  const [qty, setQty] = React.useState(current);
  const [reason, setReason] = React.useState("");
  const save = useAction(() => rpc("record_consumption", { p_customer_id: customer.id, p_quantity: qty, p_date: date }), {
    success: "Consumption updated", onSuccess: () => { qc.invalidateQueries(); onClose(); },
  });
  const request = useAction(() => rpc("request_consumption_correction", { p_customer_id: customer.id, p_date: date, p_requested_quantity: qty, p_reason: reason }), {
    success: "Correction request sent to your supplier", onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Cans used on ${formatDate(date, "EEE, d MMM")}`} description={editable ? "Set the total cans used that day. Stock is adjusted by the difference." : "This entry is more than 7 days old. Your supplier will review the correction."}>
        <Field label="Cans used" htmlFor="q"><Input id="q" type="number" min={0} max={1000} value={qty} onChange={(e) => setQty(Math.max(0, Number(e.target.value) || 0))} /></Field>
        {!editable && <Field label="Why is it wrong?" htmlFor="r" className="mt-3"><Textarea id="r" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        <Button className="mt-4 w-full" loading={save.isPending || request.isPending} onClick={() => (editable ? save.mutate(undefined) : request.mutate(undefined))}>
          {editable ? "Save" : "Send correction request"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export default function ConsumptionPage() {
  const customer = useCustomer();
  const summary = useCustomerSummary(customer.id);
  const { data, isLoading, error, refetch } = useConsumption(customer.id, 60);
  const [editing, setEditing] = React.useState<{ date: string; current: number } | null>(null);
  const today = summary.data?.prediction.today ?? format(new Date(), "yyyy-MM-dd");
  const byDate = new Map((data ?? []).map((r) => [r.consumption_date, r]));
  const days = Array.from({ length: 21 }, (_, i) => format(addDays(parseISO(today), -i), "yyyy-MM-dd"));
  const max = Math.max(1, ...days.map((d) => (byDate.get(d)?.quantity ?? 0) + (byDate.get(d)?.unmet_quantity ?? 0)));
  const last7 = days.slice(0, 7).map((d) => byDate.get(d)).filter(Boolean);
  const avg = last7.length ? (last7.reduce((s, r) => s + r!.quantity + r!.unmet_quantity, 0) / last7.length).toFixed(1) : null;

  return (
    <div className="space-y-4">
      <PageHeader title="Water usage" description="Record how many cans you use each day so Waterdrop can predict when you'll run out." />
      <QuickConsumption customerId={customer.id} today={today} />
      <Card>
        <CardHeader>
          <CardTitle>Last 3 weeks</CardTitle>
          <CardDescription>
            {avg ? `Average ${avg} cans/day over the last ${last7.length} recorded days.` : "No usage recorded yet."}
            {customer.auto_consumption_enabled && ` Automatic entry of ${customer.daily_consumption} cans/day is on.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? <LoadingState rows={2} /> : error ? <ErrorState error={error} onRetry={refetch} /> : (
            <>
              <div className="flex h-32 items-end gap-1" aria-hidden>
                {[...days].reverse().map((d) => {
                  const r = byDate.get(d);
                  const v = (r?.quantity ?? 0) + (r?.unmet_quantity ?? 0);
                  return (
                    <div key={d} className="flex flex-1 flex-col justify-end" title={`${d}: ${v}`}>
                      <div className={r?.unmet_quantity ? "rounded-t bg-stock-critical" : "rounded-t bg-primary/80"} style={{ height: `${(v / max) * 100}%`, minHeight: r ? 3 : 0 }} />
                    </div>
                  );
                })}
              </div>
              <ul className="mt-4 divide-y">
                {days.map((d, i) => {
                  const r = byDate.get(d);
                  return (
                    <li key={d} className="flex items-center justify-between py-2.5">
                      <div>
                        <p className="text-sm font-medium">{i === 0 ? "Today" : i === 1 ? "Yesterday" : formatDate(d, "EEE, d MMM")}</p>
                        <p className="text-xs text-muted-foreground">
                          {r ? `${r.source === "auto" ? "Automatic" : r.source === "correction" ? "Corrected" : "Recorded"}${r.unmet_quantity ? ` · ran out (${r.unmet_quantity} short)` : ""}` : "Not recorded"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1 text-lg font-bold tabular-nums"><Droplets className="h-4 w-4 text-primary" />{r ? r.quantity + r.unmet_quantity : "–"}</span>
                        <Button variant="ghost" size="icon" aria-label={`Edit ${d}`} onClick={() => setEditing({ date: d, current: r ? r.quantity + r.unmet_quantity : 0 })}><Pencil /></Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
      {editing && <EditDay date={editing.date} current={editing.current} editable={days.indexOf(editing.date) <= 7} onClose={() => setEditing(null)} />}
    </div>
  );
}
