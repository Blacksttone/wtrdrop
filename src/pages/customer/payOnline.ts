import { supabase } from "@/lib/supabase";

export const paymentGatewayEnabled = Boolean(import.meta.env.VITE_PAYMENT_GATEWAY_KEY);

interface RazorpayCtor {
  new (opts: Record<string, unknown>): { open: () => void; on: (e: string, cb: (r: unknown) => void) => void };
}

function loadCheckout(): Promise<RazorpayCtor> {
  const w = window as unknown as { Razorpay?: RazorpayCtor };
  if (w.Razorpay) return Promise.resolve(w.Razorpay);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => (w.Razorpay ? resolve(w.Razorpay) : reject(new Error("Payment checkout failed to load")));
    s.onerror = () => reject(new Error("Payment checkout failed to load"));
    document.body.appendChild(s);
  });
}

/**
 * Opens the gateway checkout. The order is created server-side; the payment is
 * marked successful ONLY by the verified server webhook (payment-webhook), never here.
 */
export async function payOnline(customerId: string, amount: number): Promise<void> {
  if (!(amount > 0)) throw new Error("Enter an amount");
  const { data, error } = await supabase.functions.invoke("create-payment-order", { body: { customer_id: customerId, amount } });
  if (error) throw error;
  const Razorpay = await loadCheckout();
  await new Promise<void>((resolve, reject) => {
    const rz = new Razorpay({
      key: import.meta.env.VITE_PAYMENT_GATEWAY_KEY,
      order_id: data.order_id,
      amount: data.amount_paise,
      currency: "INR",
      name: "Waterdrop",
      description: "Water bill payment",
      handler: () => resolve(),
      modal: { ondismiss: () => reject(new Error("Payment cancelled")) },
    });
    rz.on("payment.failed", () => reject(new Error("Payment failed")));
    rz.open();
  });
}
