// Sends pending email / WhatsApp notifications from the outbox.
// Triggered every 2 minutes by pg_cron (see migrations/*_cron.sql) or any scheduler
// that sends the x-cron-secret header. Safe to run concurrently (SKIP LOCKED claim).
import { json } from "../_shared/cors.ts";
import { safeEqual } from "../_shared/crypto.ts";
import { emailHtml, sendEmail, sendWhatsApp, whatsappEnabled } from "../_shared/notify.ts";
import { adminClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret || !safeEqual(req.headers.get("x-cron-secret") ?? "", secret)) {
    return json({ error: "unauthorized" }, 401);
  }
  const db = adminClient();
  const appUrl = Deno.env.get("APP_URL") ?? "https://waterdrop.app";
  const emailOn = Boolean(Deno.env.get("RESEND_API_KEY"));
  const { data: batch, error } = await db.rpc("claim_notification_batch", { p_limit: 50 });
  if (error) return json({ error: error.message }, 500);

  let sent = 0;
  let failed = 0;
  for (const n of batch ?? []) {
    try {
      if (n.channel === "email") {
        if (!emailOn || !n.email) throw new Error("email channel not configured");
        await sendEmail(n.email, n.title, emailHtml({ name: n.full_name, title: n.title, message: n.message, link: n.link, appUrl, severity: n.severity }));
      } else if (n.channel === "whatsapp") {
        if (!whatsappEnabled() || !n.phone) throw new Error("whatsapp channel not configured");
        await sendWhatsApp(n.phone, `💧 Waterdrop: ${n.title}\n${n.message}\n${appUrl}${n.link ?? ""}`);
      }
      await db.rpc("complete_notification_delivery", { p_id: n.id, p_channel: n.channel, p_ok: true });
      sent++;
    } catch (e) {
      await db.rpc("complete_notification_delivery", { p_id: n.id, p_channel: n.channel, p_ok: false, p_error: String((e as Error).message ?? e) });
      failed++;
    }
  }
  return json({ claimed: batch?.length ?? 0, sent, failed });
});
