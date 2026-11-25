import { useQueryClient } from "@tanstack/react-query";
import { Droplet } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { useAction } from "@/lib/hooks";
import { useConsumption } from "@/lib/queries";
import { rpc } from "@/lib/supabase";
import { cn } from "@/lib/utils";

/** One-tap "how many cans did we use today?" */
export function QuickConsumption({ customerId, today }: { customerId: string; today: string }) {
  const qc = useQueryClient();
  const { data } = useConsumption(customerId, 7);
  const todayRec = data?.find((r) => r.consumption_date === today);
  const current = todayRec ? todayRec.quantity + todayRec.unmet_quantity : null;
  const save = useAction(
    (qty: number) => rpc("record_consumption", { p_customer_id: customerId, p_quantity: qty, p_date: today }),
    { success: "Today's usage saved", onSuccess: () => qc.invalidateQueries() },
  );
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 font-semibold"><Droplet className="h-4 w-4 text-primary" /> Cans used today</p>
          <Link to="/app/consumption" className="text-sm text-primary">History</Link>
        </div>
        <div className="mt-3 grid grid-cols-5 gap-2" role="group" aria-label="Cans used today">
          {[0, 1, 2, 3, 4].map((n) => (
            <button
              key={n}
              disabled={save.isPending}
              onClick={() => save.mutate(n)}
              aria-pressed={current === n}
              className={cn(
                "h-14 rounded-xl border-2 text-lg font-bold transition-colors disabled:opacity-60",
                current === n ? "border-primary bg-primary text-white" : "border-border bg-card hover:border-primary/50",
              )}
            >
              {n}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {current == null ? "Tap to record today's usage." : todayRec?.source === "auto" ? "Recorded automatically from your daily setting — tap to correct." : `Recorded: ${current} can${current === 1 ? "" : "s"}. Tap to correct.`}
        </p>
      </CardContent>
    </Card>
  );
}
