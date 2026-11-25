// Creates a Razorpay order for the signed-in customer and a *pending* payment row.
// The payment becomes "succeeded" only via the verified payment-webhook.
import { corsHeaders, json } from "../_shared/cors.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "unauthorized" }, 401);

  const keyId = Deno.env.get("PAYMENT_GATEWAY_KEY");
  const keySecret = Deno.env.get("PAYMENT_GATEWAY_SECRET");
  if (!keyId || !keySecret) return json({ error: "Online payments are not configured" }, 503);

  const user = userClient(auth);
  const { data: u, error: uErr } = await user.auth.getUser();
  if (uErr || !u.user) return json({ error: "unauthorized" }, 401);

  let body: { customer_id?: string; amount?: number };
  try { body = await req.json(); } catch { return json({ error: "invalid body" }, 400); }
  const amount = Math.round(Number(body.amount) * 100) / 100;
  if (!body.customer_id || !(amount >= 1) || amount > 1_000_000) return json({ error: "invalid amount" }, 400);

  // RLS check: the caller must own this customer account.
  const { data: cust } = await user.from("customers").select("id, user_id").eq("id", body.customer_id).maybeSingle();
  if (!cust || cust.user_id !== u.user.id) return json({ error: "forbidden" }, 403);

  const receipt = `wd_${crypto.randomUUID().slice(0, 20)}`;
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: Math.round(amount * 100), currency: "INR", receipt, notes: { customer_id: cust.id } }),
  });
  if (!res.ok) return json({ error: "Payment gateway error" }, 502);
  const order = await res.json();

  const { error } = await adminClient().rpc("create_gateway_payment", {
    p_customer_id: cust.id, p_amount: amount, p_gateway: "razorpay", p_gateway_order_id: order.id, p_actor: u.user.id,
  });
  if (error) return json({ error: error.message }, 400);
  return json({ order_id: order.id, amount_paise: order.amount });
});
