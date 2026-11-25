/** Turns Supabase/PostgREST errors into friendly, user-facing messages. */
export function errorMessage(err: unknown): string {
  if (!err) return "Something went wrong";
  if (typeof err === "string") return err;
  const e = err as { message?: string; code?: string; details?: string };
  if (e.code === "42501" && !e.message) return "You do not have permission to do that.";
  if (e.message?.includes("Failed to fetch")) return "Network error — check your connection and try again.";
  if (e.message?.includes("JWT expired")) return "Your session expired. Please sign in again.";
  return e.message || "Something went wrong";
}
