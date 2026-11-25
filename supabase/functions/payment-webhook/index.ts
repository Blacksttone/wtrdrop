// Razorpay webhook. Verifies the HMAC signature over the raw body BEFORE trusting
// anything, then confirms/fails the payment idempotently in the database.
import { json } from "../_shared/cors.ts";
import { parseRazorpayEvent, verifyRazorpayWebhook } from "../_shared/crypto.ts";
import { adminClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const raw = await req.text();
  const secret = Deno.env.get("PAYMENT_GATEWAY_WEBHOOK_SECRET") ?? "";
  if (!(await verifyRazorpayWebhook(raw, req.headers.get("x-razorpay-signature"), secret))) {
    return json({ error: "invalid signature" }, 401);
  }
  let parsed;
  try { parsed = parseRazorpayEvent(JSON.parse(raw)); } catch { return json({ error: "invalid body" }, 400); }
  const db = adminClient();

  if ((parsed.event === "payment.captured" || parsed.event === "order.paid") && parsed.orderId && parsed.amountRupees != null) {
    const { error } = await db.rpc("confirm_gateway_payment", {
      p_gateway_order_id: parsed.orderId, p_gateway_payment_id: parsed.paymentId ?? parsed.orderId, p_amount: parsed.amountRupees,
    });
    // Unknown orders are acknowledged (not ours); other errors ask the gateway to retry.
    if (error && !error.message.includes("Unknown gateway order")) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (parsed.event === "payment.failed" && parsed.orderId) {
    await db.rpc("fail_gateway_payment", { p_gateway_order_id: parsed.orderId, p_reason: parsed.reason ?? "Payment failed" });
  }
  return json({ ok: true, ignored: parsed.event });
});
