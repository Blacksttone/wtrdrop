import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { errorMessage } from "./errors";
import { supabase } from "./supabase";
import type { AppNotification } from "@/types/db";

/** Mutation that toasts success/failure and invalidates the given query keys. */
export function useAction<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  opts: { success?: string | ((r: TResult) => string); invalidate?: QueryKey[]; onSuccess?: (r: TResult) => void } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.success) toast.success(typeof opts.success === "function" ? opts.success(r) : opts.success);
      (opts.invalidate ?? []).forEach((k) => qc.invalidateQueries({ queryKey: k }));
      opts.onSuccess?.(r);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useNotifications(userId: string | undefined) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["notifications", userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select("id, notification_type, severity, title, message, link, read_at, created_at")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as AppNotification[];
    },
    refetchInterval: 60_000,
  });

  // Live updates via Supabase Realtime (RLS restricts rows to this user).
  React.useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, (payload) => {
        const n = payload.new as AppNotification;
        if (n.severity === "critical") toast.error(n.title, { description: n.message });
        else toast(n.title, { description: n.message });
        qc.invalidateQueries();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, qc]);

  return q;
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[] | null) => {
      const { error } = await supabase.rpc("mark_notifications_read", { p_ids: ids });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}
