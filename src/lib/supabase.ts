import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

// Only the public anon key is ever used in the browser. Privileged work
// happens in Postgres SECURITY DEFINER functions and Edge Functions.
export const supabase = createClient(url ?? "http://localhost:54321", anonKey ?? "public-anon-key", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Calls a Postgres RPC and throws on error so React Query can handle it. */
export async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}
