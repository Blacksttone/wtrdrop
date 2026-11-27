// Sends pending phone push / email / WhatsApp notifications from the outbox.
// Called right away by a database trigger when a notification is created, and
// every 2 minutes by pg_cron as a retry. Both send the x-cron-secret header,
// which is checked against the vault (or the CRON_SECRET env, if set).
// Safe to run concurrently (SKIP LOCKED claim).
import { json } from "../_shared/cors.ts";
import { safeEqual } from "../_shared/crypto.ts";
import { buildMessage, readServiceAccount, sendPush } from "../_shared/fcm.ts";
import { emailHtml, sendEmail, sendWhatsApp, whatsappEnabled } from "../_shared/notify.ts";
import { adminClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const db = adminClient();
  const given = req.headers.get("x-cron-secret") ?? "";
  const envSecret = Deno.env.get("CRON_SECRET") ?? "";
  const authorized = (envSecret && safeEqual(given, envSecret))
    || (given !== "" && (await db.rpc("verify_dispatch_secret", { p_secret: given })).data === true);
  if (!authorized) return json({ error: "unauthorized" }, 401);

  const appUrl = Deno.env.get("APP_URL") ?? "https://waterdrop.app";
  const emailOn = Boolean(Deno.env.get("RESEND_API_KEY"));
  const rawSa = Deno.env.get("FCM_SERVICE_ACCOUNT");
  const sa = readServiceAccount(rawSa);
  // Status only (never the secret itself): helps check the setup.
  const pushSetup = sa ? "ready" : rawSa ? "invalid FCM_SERVICE_ACCOUNT (not a service-account JSON)" : "FCM_SERVICE_ACCOUNT not set";
  const { data: batch, error } = await db.rpc("claim_notification_batch", { p_limit: 50 });
  if (error) return json({ error: error.message }, 500);

  let sent = 0;
  let failed = 0;
  for (const n of batch ?? []) {
    try {
      if (n.channel === "push") {
        if (!sa) throw new Error("not configured: FCM_SERVICE_ACCOUNT");
        const { data: tokens } = await db.from("push_tokens").select("id, token").eq("user_id", n.user_id);
        if (!tokens?.length) throw new Error("not configured: no phone registered");
        let delivered = 0;
        let lastError = "";
        for (const t of tokens) {
          try {
            const r = await sendPush(sa, buildMessage(t.token, n));
            if (r === "ok") delivered++;
            else await db.from("push_tokens").delete().eq("id", t.id); // app uninstalled / token expired
          } catch (e) {
            lastError = String((e as Error).message ?? e);
          }
        }
        if (!delivered) throw new Error(lastError || "not configured: no valid phone token");
      } else if (n.channel === "email") {
        if (!emailOn || !n.email) throw new Error("not configured: email");
        await sendEmail(n.email, n.title, emailHtml({ name: n.full_name, title: n.title, message: n.message, link: n.link, appUrl, severity: n.severity }));
      } else if (n.channel === "whatsapp") {
        if (!whatsappEnabled() || !n.phone) throw new Error("not configured: whatsapp");
        await sendWhatsApp(n.phone, `💧 Waterdrop: ${n.title}\n${n.message}\n${appUrl}${n.link ?? ""}`);
      }
      await db.rpc("complete_notification_delivery", { p_id: n.id, p_channel: n.channel, p_ok: true });
      sent++;
    } catch (e) {
      await db.rpc("complete_notification_delivery", { p_id: n.id, p_channel: n.channel, p_ok: false, p_error: String((e as Error).message ?? e) });
      failed++;
    }
  }
  return json({ claimed: batch?.length ?? 0, sent, failed, push: pushSetup });
});
