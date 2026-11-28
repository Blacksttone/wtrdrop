/** Turns Supabase/PostgREST errors into friendly, user-facing messages. */
export function errorMessage(err: unknown): string {
  if (!err) return "Something went wrong";
  if (typeof err === "string") return err;
  const e = err as { message?: string; code?: string; details?: string };
  if (e.code === "42501" && !e.message) return "You do not have permission to do that.";
  if (e.message?.includes("Failed to fetch")) return "Network error — check your connection and try again.";
  if (e.message?.includes("JWT expired")) return "Your session expired. Please sign in again.";
  const m = e.message?.toLowerCase() ?? "";
  if (m.includes("email rate limit")) return "Too many sign-ups or emails right now. Please try again in an hour.";
  if (m.includes("error sending confirmation email") || m.includes("error sending") && m.includes("email"))
    return "We couldn't send the verification email right now. Please try again in a few minutes.";
  if (m.includes("for security purposes") && m.includes("seconds")) return "Please wait a minute before asking for another email.";
  if (m.includes("invalid login credentials")) return "Wrong email or password. Tap the eye icon to check what you typed.";
  if (m.includes("email not confirmed")) return "Please open the confirmation email we sent you, then sign in.";
  if (m.includes("user already registered")) return "An account with this email already exists. Please sign in.";
  return e.message || "Something went wrong";
}
