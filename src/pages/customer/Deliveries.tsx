import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Minus, PackageCheck, Plus } from "lucide-react";
import * as React from "react";
import { useCustomer } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { StatusBadge } from "@/components/water/StatusBadge";
import { formatDate } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { useCustomerDeliveries } from "@/lib/queries";
import { rpc } from "@/lib/supabase";
import type { Delivery } from "@/types/db";

function ConfirmDialog({ delivery, onClose }: { delivery: Delivery; onClose: () => void }) {
  const qc = useQueryClient();
  const [qty, setQty] = React.useState(delivery.actual_quantity);
  const [note, setNote] = React.useState("");
  const confirm = useAction(
    () => rpc("confirm_delivery", { p_delivery_id: delivery.id, p_received_quantity: qty, p_note: note || null }),
    { success: `${qty} cans added to your stock`, onSuccess: () => { qc.invalidateQueries(); onClose(); } },
  );
  const short = qty < delivery.actual_quantity;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="How many cans did you receive?" description={`Your supplier recorded ${delivery.actual_quantity} cans on ${formatDate(delivery.delivery_date)}. Count the full cans and confirm.`}>
        <div className="flex items-center justify-center gap-4 py-2">
          <Button variant="outline" size="icon" className="h-14 w-14 rounded-full" onClick={() => setQty(Math.max(0, qty - 1))} aria-label="Fewer"><Minus /></Button>
          <Input aria-label="Cans received" type="number" min={0} max={1000} value={qty} onChange={(e) => setQty(Math.max(0, Math.min(1000, Number(e.target.value) || 0)))} className="h-16 w-28 text-center text-3xl font-bold" />
          <Button variant="outline" size="icon" className="h-14 w-14 rounded-full" onClick={() => setQty(Math.min(1000, qty + 1))} aria-label="More"><Plus /></Button>
        </div>
        {short && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">That's {delivery.actual_quantity - qty} fewer than recorded. Your supplier will be notified and you'll only be billed for {qty}.</p>}
        <Field label="Note (optional)" htmlFor="note" className="mt-4">
          <Input id="note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={short ? "e.g. 2 cans were missing" : ""} />
        </Field>
        <p className="mt-3 text-xs text-muted-foreground">Confirmation can't be changed later; your supplier can correct mistakes with an adjustment.</p>
        <Button size="lg" className="mt-4 w-full" loading={confirm.isPending} onClick={() => confirm.mutate(undefined)}>
          <CheckCircle2 /> Confirm {qty} can{qty === 1 ? "" : "s"} received
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export default function CustomerDeliveries() {
  const customer = useCustomer();
  const { data, isLoading, error, refetch } = useCustomerDeliveries(customer.id);
  const [confirming, setConfirming] = React.useState<Delivery | null>(null);
  const pending = data?.filter((d) => d.status === "awaiting_confirmation") ?? [];
  const history = data?.filter((d) => d.status !== "awaiting_confirmation") ?? [];

  return (
    <div>
      <PageHeader title="Deliveries" description="Only cans you confirm are added to your stock and bill." />
      {isLoading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={refetch} /> : (
        <div className="space-y-6">
          {pending.length > 0 && (
            <div className="space-y-3">
              <h2 className="font-semibold">Waiting for your confirmation</h2>
              {pending.map((d) => (
                <Card key={d.id} className="border-amber-300 bg-amber-50/60">
                  <CardContent className="flex items-center gap-4 p-4">
                    <PackageCheck className="h-8 w-8 text-amber-600" />
                    <div className="flex-1">
                      <p className="font-bold">{d.actual_quantity} cans delivered</p>
                      <p className="text-sm text-muted-foreground">{formatDate(d.delivery_date, "EEE, d MMM")}{d.empty_cans_collected > 0 ? ` · ${d.empty_cans_collected} empty cans taken back` : ""}{d.notes ? ` · ${d.notes}` : ""}</p>
                    </div>
                    <Button onClick={() => setConfirming(d)}>Confirm</Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          <Card>
            <CardHeader><CardTitle>Delivery history</CardTitle></CardHeader>
            <CardContent>
              {!history.length ? <EmptyState title="No deliveries yet" /> : (
                <ul className="divide-y">
                  {history.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 py-3">
                      <div>
                        <p className="font-medium">{formatDate(d.delivery_date, "EEE, d MMM yyyy")}</p>
                        <p className="text-xs text-muted-foreground">
                          Expected {d.expected_quantity} · Supplier recorded {d.actual_quantity}
                          {d.adjusted_quantity !== 0 && ` · Corrected ${d.adjusted_quantity > 0 ? "+" : ""}${d.adjusted_quantity}`}
                          {d.empty_cans_collected > 0 && ` · ${d.empty_cans_collected} empty taken back`}
                        </p>
                        {d.customer_note && <p className="text-xs text-muted-foreground">“{d.customer_note}”</p>}
                      </div>
                      <div className="text-right">
                        {d.status === "confirmed" ? <p className="text-lg font-bold">{(d.confirmed_quantity ?? 0) + d.adjusted_quantity}</p> : null}
                        <StatusBadge status={d.status} />
                        {d.status === "confirmed" && (d.discrepancy ?? 0) < 0 && <p className="mt-1 text-xs font-semibold text-amber-700">{-(d.discrepancy ?? 0)} short</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      {confirming && <ConfirmDialog delivery={confirming} onClose={() => setConfirming(null)} />}
    </div>
  );
}
