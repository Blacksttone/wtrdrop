// Suppliers pay their monthly Waterdrop bill through Cashfree.
//   POST /cashfree-platform/create   (signed-in owner/manager) { invoice_id } -> { payment_session_id, mode }
//   POST /cashfree-platform/verify   { order_id } -> re-checks the order with Cashfree and settles it
//   POST /cashfree-platform/webhook  (Cashfree; signature checked) -> settles the order
// A bill is marked paid only after Cashfree itself reports the order PAID.
import { cashfreeConfig, createOrder, getOrder, verifyCashfreeSignature, webhookOrderId } from "../_shared/cashfree.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";

const fnUrl = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1/cashfree-platform`;
const siteUrl = () => (Deno.env.get("APP_URL") ?? "https://wtrdrop.blackstoneking7.workers.dev").replace(/\/$/, "");

async function settle(orderId: string) {
  const cf = cashfreeConfig((k) => Deno.env.get(k));
  if (!cf) return { status: "not_configured" };
  const db = adminClient();
  const { data: pp } = await db.from("platform_payments").select("id, amount, status").eq("order_id", orderId).maybeSingle();
  if (!pp) return { status: "unknown_order" };
  if (pp.status === "paid") return { status: "paid" };
  const order = await getOrder(cf, orderId);
  if (order.order_status === "PAID") {
    const { error } = await db.rpc("finalize_platform_payment", { p_order_id: orderId, p_paid_amount: order.order_amount, p_gateway_payment_id: order.cf_order_id ?? null });
    if (error) throw new Error(error.message);
    return { status: "paid" };
  }
  if (order.order_status === "EXPIRED" || order.order_status === "TERMINATED") {
    await db.rpc("fail_platform_payment", { p_order_id: orderId });
    return { status: "failed" };
  }
  return { status: "pending" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const action = new URL(req.url).pathname.split("/").pop();
  const cf = cashfreeConfig((k) => Deno.env.get(k));

  try {
    if (action === "webhook") {
      const raw = await req.text();
      if (!cf || !(await verifyCashfreeSignature(raw, req.headers.get("x-webhook-timestamp"), req.headers.get("x-webhook-signature"), cf.secret))) {
        return json({ error: "invalid signature" }, 401);
      }
      const orderId = webhookOrderId(JSON.parse(raw));
      if (orderId) await settle(orderId);
      return json({ ok: true });
    }

    if (action === "verify") {
      const { order_id } = await req.json().catch(() => ({}));
      if (typeof order_id !== "string" || !/^[A-Za-z0-9_-]{6,45}$/.test(order_id)) return json({ error: "invalid order" }, 400);
      return json(await settle(order_id));
    }

    if (action === "create") {
      if (!cf) return json({ error: "Online payment is not set up yet. Please pay with UPI." }, 503);
      const auth = req.headers.get("Authorization");
      if (!auth) return json({ error: "unauthorized" }, 401);
      const { invoice_id } = await req.json().catch(() => ({}));
      if (typeof invoice_id !== "string") return json({ error: "invalid bill" }, 400);
      // As the signed-in user: checks owner/manager + unpaid bill.
      const { data: info, error } = await userClient(auth).rpc("start_platform_payment", { p_invoice_id: invoice_id });
      if (error) return json({ error: error.message }, 400);
      const orderId = `wdp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const { error: recErr } = await adminClient().rpc("record_platform_order", {
        p_invoice_id: invoice_id, p_order_id: orderId, p_amount: info.amount, p_user: info.user_id,
      });
      if (recErr) return json({ error: recErr.message }, 400);
      const order = await createOrder(cf, {
        orderId, amount: Number(info.amount), customerId: `sup_${String(info.supplier_id).replace(/-/g, "")}`.slice(0, 50),
        phone: info.phone, email: info.email, name: info.business_name,
        returnUrl: `${siteUrl()}/pay/done?order_id=${orderId}`, notifyUrl: `${fnUrl()}/webhook`,
        note: `Waterdrop bill ${info.invoice_number}`,
      });
      return json({ order_id: orderId, payment_session_id: order.payment_session_id, mode: cf.env });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 502);
  }
});
