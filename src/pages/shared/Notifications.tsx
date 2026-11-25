import { AlertOctagon, AlertTriangle, BellOff, CheckCircle2, Info } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { timeAgo } from "@/lib/format";
import { useMarkRead, useNotifications } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const ICON = { info: Info, success: CheckCircle2, warning: AlertTriangle, critical: AlertOctagon };
const TONE = { info: "text-primary bg-secondary", success: "text-stock-ok bg-emerald-50", warning: "text-amber-600 bg-amber-50", critical: "text-stock-critical bg-red-50" };

export default function NotificationsPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useNotifications(session?.user.id);
  const markRead = useMarkRead();
  const unread = data?.filter((n) => !n.read_at) ?? [];
  const critical = unread.filter((n) => n.severity === "critical");

  return (
    <div>
      <PageHeader title="Notifications" actions={unread.length > 0 && <Button variant="outline" size="sm" onClick={() => markRead.mutate(null)}>Mark all as read</Button>} />
      {critical.length > 0 && (
        <div className="mb-4 rounded-xl border-2 border-red-300 bg-red-50 p-4" role="alert">
          <p className="flex items-center gap-2 font-bold text-red-800"><AlertOctagon className="h-5 w-5" /> {critical[0].title}</p>
          <p className="mt-1 text-sm text-red-800">{critical[0].message}</p>
        </div>
      )}
      {isLoading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? (
        <EmptyState icon={BellOff} title="You're all caught up" description="Alerts about stock, orders, deliveries and bills appear here." />
      ) : (
        <Card className="divide-y">
          {data.map((n) => {
            const Icon = ICON[n.severity];
            return (
              <button key={n.id} className={cn("flex w-full gap-3 p-4 text-left hover:bg-muted/50", !n.read_at && "bg-secondary/40")}
                onClick={() => { if (!n.read_at) markRead.mutate([n.id]); if (n.link) navigate(n.link); }}>
                <span className={cn("h-fit rounded-lg p-2", TONE[n.severity])}><Icon className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm", !n.read_at ? "font-semibold" : "font-medium")}>{n.title}</p>
                  <p className="text-sm text-muted-foreground">{n.message}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{timeAgo(n.created_at)}</p>
                </div>
                {!n.read_at && <span className="mt-2 h-2 w-2 rounded-full bg-primary" aria-label="Unread" />}
              </button>
            );
          })}
        </Card>
      )}
    </div>
  );
}
