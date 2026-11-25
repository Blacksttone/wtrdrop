// HTTP entry point for schedulers other than pg_cron (e.g. Vercel Cron, GitHub
// Actions). Every job is idempotent, so retries and overlaps are safe.
//   POST /run-scheduled-jobs   { "jobs": ["auto_consumption", "predictions", "billing", "reminders"] }
//   header: x-cron-secret: <CRON_SECRET>
import { json } from "../_shared/cors.ts";
import { safeEqual } from "../_shared/crypto.ts";
import { adminClient } from "../_shared/supabase.ts";

const JOBS: Record<string, { fn: string; args?: () => Record<string, unknown> }> = {
  auto_consumption: { fn: "process_auto_consumption" },
  predictions: { fn: "refresh_all_predictions" },
  billing: { fn: "run_monthly_billing", args: () => ({ p_as_of: istToday() }) },
  reminders: { fn: "process_payment_reminders", args: () => ({ p_today: istToday() }) },
};

function istToday() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret || !safeEqual(req.headers.get("x-cron-secret") ?? "", secret)) return json({ error: "unauthorized" }, 401);
  let requested = Object.keys(JOBS);
  try {
    const body = await req.json();
    if (Array.isArray(body?.jobs)) requested = body.jobs.filter((j: string) => j in JOBS);
  } catch { /* run all */ }
  const db = adminClient();
  const results: Record<string, unknown> = {};
  for (const name of requested) {
    const job = JOBS[name];
    const { data, error } = await db.rpc(job.fn, job.args?.() ?? {});
    results[name] = error ? { error: error.message } : data;
  }
  return json(results);
});
