import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageOpen, Pencil, Recycle } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/states";
import { formatDate, todayISO } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { rpc } from "@/lib/supabase";
import type { Delivery } from "@/types/db";

/** Supplier cans currently at a customer (full cans given − empty cans taken back). */
export function useCansWithCustomer(customerId: string) {
  return useQuery({ queryKey: ["cans-out", customerId], queryFn: () => rpc<number>("cans_with_customer", { p_customer_id: customerId }) });
}

const invalidateCans = (qc: ReturnType<typeof useQueryClient>) => {
  for (const k of ["cans-out", "deliveries", "supplier-customers", "can-report"]) qc.invalidateQueries({ queryKey: [k] });
};

/** Small pencil to fix how many empty cans were taken back on a delivery. */
export function EditEmptyCans({ delivery }: { delivery: Pick<Delivery, "id" | "empty_cans_collected" | "status" | "delivery_date"> }) {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState(String(delivery.empty_cans_collected));
  const save = useAction(() => rpc("set_delivery_empty_cans", { p_delivery_id: delivery.id, p_empty_cans: Number(value) }), {
    success: "Empty cans updated", onSuccess: () => { invalidateCans(qc); setOpen(false); },
  });
  if (delivery.status === "cancelled") return <span>{delivery.empty_cans_collected}</span>;
  return (
    <>
      <button type="button" className="inline-flex items-center gap-1 underline decoration-dotted" aria-label="Change empty cans"
        onClick={() => { setValue(String(delivery.empty_cans_collected)); setOpen(true); }}>
        {delivery.empty_cans_collected} <Pencil className="h-3 w-3 text-muted-foreground" />
      </button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent title="Empty cans taken back" description={`Delivery on ${formatDate(delivery.delivery_date)}`}>
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
              <Field label="Empty cans collected" htmlFor="empty-cans-edit"><Input id="empty-cans-edit" type="number" inputMode="numeric" min={0} max={1000} required value={value} onChange={(e) => setValue(e.target.value)} /></Field>
              <Button type="submit" className="w-full" loading={save.isPending}>Save</Button>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** "Cans with customer" with a correction button for owner / manager. */
export function CansWithCustomerCard({ customerId, canCorrect }: { customerId: string; canCorrect: boolean }) {
  const qc = useQueryClient();
  const cans = useCansWithCustomer(customerId);
  const [open, setOpen] = React.useState(false);
  const [count, setCount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const save = useAction(() => rpc("set_cans_with_customer", { p_customer_id: customerId, p_count: Number(count), p_reason: reason || null }), {
    success: "Can count updated", onSuccess: () => { invalidateCans(qc); setOpen(false); },
  });
  const n = cans.data ?? 0;
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your cans with customer</p>
      <p className={`mt-1 text-2xl font-bold ${n < 0 ? "text-stock-critical" : ""}`}>{cans.isLoading ? "…" : n}</p>
      <p className="text-xs text-muted-foreground">{n < 0 ? "More empties taken than given — please correct" : "Full given − empty taken back"}</p>
      {canCorrect && (
        <button type="button" className="mt-1 text-xs text-primary underline" onClick={() => { setCount(String(Math.max(n, 0))); setReason(""); setOpen(true); }}>Correct count</button>
      )}
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent title="How many of your cans does the customer have now?" description="Use this once for cans given before you started using Waterdrop, or after counting.">
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
              <Field label="Cans with customer now" htmlFor="cans-now"><Input id="cans-now" type="number" inputMode="numeric" min={0} max={10000} required value={count} onChange={(e) => setCount(e.target.value)} /></Field>
              <Field label="Reason (optional)" htmlFor="cans-reason"><Input id="cans-reason" value={reason} maxLength={200} placeholder="e.g. counted at the house" onChange={(e) => setReason(e.target.value)} /></Field>
              <Button type="submit" className="w-full" loading={save.isPending}>Save</Button>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

interface CanReport {
  date: string; deliveries: number; full_cans: number; empty_cans: number; cans_with_customers: number;
  by_person: { name: string; deliveries: number; full_cans: number; empty_cans: number }[];
}

/** Daily can movement: full cans given vs empty cans brought back, per person. */
export function CanReportCard() {
  const [date, setDate] = React.useState(todayISO());
  const q = useQuery({ queryKey: ["can-report", date], queryFn: () => rpc<CanReport>("supplier_can_report", { p_date: date }), refetchInterval: 60_000 });
  const r = q.data;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Cans {date === todayISO() ? "today" : formatDate(date, "d MMM")}</CardTitle>
          <CardDescription>Full cans given out and empty cans brought back for refilling.</CardDescription>
        </div>
        <Input aria-label="Report date" type="date" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value || todayISO())} className="w-40" />
      </CardHeader>
      <CardContent>
        {q.isLoading || !r ? <LoadingState rows={2} /> : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-secondary p-3"><PackageOpen className="mx-auto h-5 w-5 text-primary" /><p className="text-2xl font-bold">{r.full_cans}</p><p className="text-xs text-muted-foreground">Full cans given</p></div>
              <div className="rounded-xl bg-secondary p-3"><Recycle className="mx-auto h-5 w-5 text-stock-ok" /><p className="text-2xl font-bold">{r.empty_cans}</p><p className="text-xs text-muted-foreground">Empty cans back</p></div>
              <div className="rounded-xl bg-secondary p-3"><p className="text-2xl font-bold">{r.cans_with_customers}</p><p className="text-xs text-muted-foreground">Your cans with customers (all)</p></div>
            </div>
            {r.full_cans !== r.empty_cans && r.deliveries > 0 && (
              <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
                {r.full_cans > r.empty_cans ? `${r.full_cans - r.empty_cans} more cans went out than came back today.` : `${r.empty_cans - r.full_cans} more empty cans came back than went out today.`}
              </p>
            )}
            {r.by_person.length > 0 && (
              <ul className="divide-y text-sm">
                {r.by_person.map((p) => (
                  <li key={p.name} className="flex items-center justify-between py-2">
                    <span className="font-medium">{p.name} <span className="text-xs text-muted-foreground">· {p.deliveries} deliveries</span></span>
                    <span><b>{p.full_cans}</b> full out · <b>{p.empty_cans}</b> empty back</span>
                  </li>
                ))}
              </ul>
            )}
            {r.deliveries === 0 && <p className="text-center text-sm text-muted-foreground">No deliveries on this day.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
