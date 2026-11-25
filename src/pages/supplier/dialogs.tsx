import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { formatDate, todayISO } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { rpc } from "@/lib/supabase";
import type { CustomerListRow, Delivery } from "@/types/db";

export const useCustomerList = () =>
  useQuery({ queryKey: ["supplier-customers"], queryFn: () => rpc<CustomerListRow[]>("list_supplier_customers") });

const useInvalidateAll = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
};

export function RecordDeliveryDialog({ onClose, customerId, order }: {
  onClose: () => void;
  customerId?: string;
  order?: { id: string; customer_id: string; quantity: number };
}) {
  const customers = useCustomerList();
  const invalidate = useInvalidateAll();
  const [cid, setCid] = React.useState(order?.customer_id ?? customerId ?? "");
  const [expected, setExpected] = React.useState(String(order?.quantity ?? ""));
  const [actual, setActual] = React.useState(String(order?.quantity ?? ""));
  const [date, setDate] = React.useState(todayISO());
  const [notes, setNotes] = React.useState("");
  const selected = customers.data?.find((c) => c.id === cid);
  const save = useAction(
    () => rpc<Delivery>("record_delivery", {
      p_customer_id: cid, p_expected_quantity: Number(expected), p_actual_quantity: Number(actual),
      p_delivery_date: date, p_order_id: order?.id ?? null, p_notes: notes || null,
    }),
    {
      success: (d) => (d.status === "confirmed" ? "Delivery recorded and confirmed (offline customer)" : "Delivery recorded — customer asked to confirm"),
      onSuccess: () => { invalidate(); onClose(); },
    },
  );
  const valid = cid && expected !== "" && actual !== "" && Number(expected) >= 0 && Number(actual) >= 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Record delivery" description="Stock updates only when the customer confirms the quantity they received.">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(undefined); }}>
          <Field label="Customer" htmlFor="cust">
            <Select id="cust" required value={cid} disabled={Boolean(order)} onChange={(e) => setCid(e.target.value)}>
              <option value="">Select customer…</option>
              {customers.data?.filter((c) => c.status === "active").map((c) => (
                <option key={c.id} value={c.id}>{c.customer_name} — {c.address.slice(0, 30)} ({c.current_stock} in stock)</option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Expected quantity" htmlFor="exp" hint="What was ordered / planned"><Input id="exp" type="number" min={0} max={1000} required value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
            <Field label="Actually delivered" htmlFor="act" hint="Cans handed over"><Input id="act" type="number" min={0} max={1000} required value={actual} onChange={(e) => setActual(e.target.value)} /></Field>
          </div>
          <Field label="Delivery date" htmlFor="dd"><Input id="dd" type="date" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Notes (optional)" htmlFor="nt"><Input id="nt" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          {selected && !selected.has_app && <p className="rounded-lg bg-secondary p-3 text-xs">{selected.customer_name} has no app account, so this delivery will be confirmed on their behalf and flagged as supplier-confirmed.</p>}
          {Number(actual) < Number(expected) && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Delivering {Number(expected) - Number(actual)} fewer than expected — this will appear in your accuracy report.</p>}
          <Button type="submit" className="w-full" disabled={!valid} loading={save.isPending}>Save delivery</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AdjustDeliveryDialog({ delivery, onClose }: { delivery: Delivery; onClose: () => void }) {
  const invalidate = useInvalidateAll();
  const current = (delivery.confirmed_quantity ?? 0) + delivery.adjusted_quantity;
  const [qty, setQty] = React.useState(String(current));
  const [reason, setReason] = React.useState("");
  const save = useAction(() => rpc("adjust_delivery", { p_delivery_id: delivery.id, p_new_quantity: Number(qty), p_reason: reason }), {
    success: "Adjustment recorded", onSuccess: () => { invalidate(); onClose(); },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Correct confirmed delivery" description={`${formatDate(delivery.delivery_date)} · currently ${current} cans. The original record is kept; an adjustment entry is added and billed in the next cycle.`}>
        <div className="space-y-4">
          <Field label="Correct quantity" htmlFor="q"><Input id="q" type="number" min={0} max={1000} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label="Reason (required)" htmlFor="r"><Textarea id="r" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Button className="w-full" disabled={reason.trim().length < 3 || Number(qty) === current} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save adjustment</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RecordPaymentDialog({ onClose, customerId }: { onClose: () => void; customerId?: string }) {
  const customers = useCustomerList();
  const invalidate = useInvalidateAll();
  const [cid, setCid] = React.useState(customerId ?? "");
  const [amount, setAmount] = React.useState("");
  const [method, setMethod] = React.useState("cash");
  const [ref, setRef] = React.useState("");
  const [date, setDate] = React.useState(todayISO());
  const balance = customers.data?.find((c) => c.id === cid)?.balance;
  const save = useAction(
    () => rpc("record_payment", { p_customer_id: cid, p_amount: Number(amount), p_method: method, p_reference: ref || null, p_payment_date: date }),
    { success: "Payment recorded", onSuccess: () => { invalidate(); onClose(); } },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Record payment received">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
          <Field label="Customer" htmlFor="pc">
            <Select id="pc" required value={cid} onChange={(e) => setCid(e.target.value)}>
              <option value="">Select customer…</option>
              {customers.data?.map((c) => <option key={c.id} value={c.id}>{c.customer_name} (balance ₹{Number(c.balance).toFixed(2)})</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount (₹)" htmlFor="pa" hint={balance != null ? `Outstanding ₹${Number(balance).toFixed(2)}` : undefined}>
              <Input id="pa" type="number" min={0.01} step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Method" htmlFor="pm">
              <Select id="pm" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option>
              </Select>
            </Field>
            <Field label="Reference" htmlFor="pr"><Input id="pr" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
            <Field label="Date" htmlFor="pd"><Input id="pd" type="date" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
          <Button type="submit" className="w-full" disabled={!cid || !(Number(amount) > 0)} loading={save.isPending}>Save payment</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function StockMovementDialog({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const invalidate = useInvalidateAll();
  const [type, setType] = React.useState<"return" | "damage" | "adjustment">("return");
  const [qty, setQty] = React.useState("");
  const [reason, setReason] = React.useState("");
  const save = useAction(() => rpc("record_stock_movement", { p_customer_id: customerId, p_type: type, p_quantity: Number(qty), p_reason: reason }), {
    success: "Stock movement recorded", onSuccess: () => { invalidate(); onClose(); },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Record stock movement" description="Returned full cans, damaged cans, or a manual correction. Every movement is logged with your reason.">
        <div className="space-y-4">
          <Field label="Type" htmlFor="t">
            <Select id="t" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="return">Return (full cans taken back)</option>
              <option value="damage">Damaged / unusable cans</option>
              <option value="adjustment">Manual adjustment (+/−)</option>
            </Select>
          </Field>
          <Field label={type === "adjustment" ? "Change in cans (use − to reduce)" : "Cans"} htmlFor="q"><Input id="q" type="number" min={type === "adjustment" ? -1000 : 1} max={1000} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label="Reason" htmlFor="r"><Textarea id="r" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Button className="w-full" disabled={!Number(qty) || reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CreditNoteDialog({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const invalidate = useInvalidateAll();
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const save = useAction(() => rpc("issue_credit_note", { p_customer_id: customerId, p_amount: Number(amount), p_reason: reason }), {
    success: "Credit note issued", onSuccess: () => { invalidate(); onClose(); },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Issue credit note" description="Finalized bills are never edited. A credit reduces the customer's balance and appears on the next bill.">
        <div className="space-y-4">
          <Field label="Amount (₹)" htmlFor="ca"><Input id="ca" type="number" min={0.01} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Reason" htmlFor="cr"><Textarea id="cr" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Button className="w-full" disabled={!(Number(amount) > 0) || reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined)}>Issue credit</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
