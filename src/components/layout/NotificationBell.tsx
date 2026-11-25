import { Bell } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { useNotifications } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export function NotificationBell({ to, className }: { to: string; className?: string }) {
  const { session } = useAuth();
  const { data } = useNotifications(session?.user.id);
  const unread = data?.filter((n) => !n.read_at).length ?? 0;
  const critical = data?.some((n) => !n.read_at && n.severity === "critical");
  return (
    <Link to={to} className={cn("relative rounded-full p-2 hover:bg-secondary", className)} aria-label={`Notifications, ${unread} unread`}>
      <Bell className="h-5 w-5" />
      {unread > 0 && (
        <span className={cn("absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white", critical ? "bg-stock-critical" : "bg-primary")}>
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
