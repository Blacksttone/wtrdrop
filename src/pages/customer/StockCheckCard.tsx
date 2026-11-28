import { useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Minus, Plus, X } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { errorMessage } from "@/lib/errors";
import { rpc } from "@/lib/supabase";
import type { Customer } from "@/types/db";

const SIX_DAYS = 6 * 24 * 3600 * 1000;

/** Due when opened from the Sunday reminder, or on Sat/Sun when there was no count in the last 6 days. */
export function stockCheckDue(c: Pick<Customer, "last_stock_check_at">, now = new Date(), fromLink = false) {
  if (fromLink) return true;
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  const last = c.last_stock_check_at ? new Date(c.last_stock_check_at).getTime() : 0;
  return weekend && now.getTime() - last >= SIX_DAYS;
}

/** "How many full cans do you have now?" — the count corrects the stock. */
export function StockCheckCard({ customer, current }: { customer: Customer; current: number }) {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const [params, setParams] = useSearchParams();
  const fromLink = params.get("stockcheck") === "1";
  const [hidden, setHidden] = React.useState(false);
  const [count, setCount] = React.useState(current);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setCount(current), [current]);
  if (hidden || !stockCheckDue(customer, new Date(), fromLink)) return null;
  const close = () => {
    setHidden(true);
    if (fromLink) { params.delete("stockcheck"); setParams(params, { replace: true }); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await rpc<{ change: number }>("customer_stock_check", { p_customer_id: customer.id, p_count: count });
      toast.success(r.change === 0 ? "Thanks! Your stock is correct." : `Updated to ${count} cans.`);
      qc.invalidateQueries();
      await refresh();
      close();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="border-primary/40 bg-secondary/60">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <ClipboardCheck className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
          <div className="flex-1">
            <p className="font-semibold">Weekly stock check</p>
            <p className="text-sm text-muted-foreground">Count your <b>full</b> water cans and update. It keeps your "runs out" date right.</p>
          </div>
          <button type="button" aria-label="Later" onClick={close} className="text-muted-foreground"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex items-center justify-center gap-4">
          <Button type="button" size="icon" variant="outline" aria-label="One less" onClick={() => setCount(Math.max(0, count - 1))}><Minus /></Button>
          <span className="w-16 text-center text-4xl font-extrabold tabular-nums" aria-live="polite">{count}</span>
          <Button type="button" size="icon" variant="outline" aria-label="One more" onClick={() => setCount(Math.min(1000, count + 1))}><Plus /></Button>
        </div>
        <Button className="w-full" loading={busy} onClick={save}>{count === current ? `Yes, I have ${count} full cans` : `Update to ${count} cans`}</Button>
      </CardContent>
    </Card>
  );
}
