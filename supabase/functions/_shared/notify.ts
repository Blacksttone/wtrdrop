// Email (Resend) + optional WhatsApp (Meta WhatsApp Cloud API) senders.
// Keys come from Edge Function secrets — never hardcoded, never sent to the browser.

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function emailHtml(opts: { name?: string | null; title: string; message: string; link?: string | null; appUrl: string; severity: string }) {
  const color = opts.severity === "critical" ? "#dc2626" : opts.severity === "warning" ? "#d97706" : "#0b6bcb";
  const href = opts.link ? `${opts.appUrl}${opts.link}` : opts.appUrl;
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;overflow:hidden">
  <tr><td style="background:#0b6bcb;padding:18px 24px;color:#fff;font-size:20px;font-weight:800">💧 Waterdrop</td></tr>
  <tr><td style="padding:24px">
    <p style="margin:0 0 6px;color:#64748b;font-size:14px">Hi ${escapeHtml(opts.name || "there")},</p>
    <h1 style="margin:0 0 10px;font-size:20px;color:${color}">${escapeHtml(opts.title)}</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#1e293b;line-height:1.5">${escapeHtml(opts.message)}</p>
    <a href="${escapeHtml(href)}" style="display:inline-block;background:#0b6bcb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">Open Waterdrop</a>
  </td></tr>
  <tr><td style="padding:16px 24px;color:#94a3b8;font-size:12px">Never Run Out of Water. · You can change alert preferences in Settings.</td></tr>
  </table></td></tr></table></body></html>`;
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY not configured");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("EMAIL_FROM") ?? "Waterdrop <onboarding@resend.dev>", to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

export const whatsappEnabled = () => Boolean(Deno.env.get("WHATSAPP_PROVIDER_API_KEY") && Deno.env.get("WHATSAPP_PHONE_NUMBER_ID"));

export async function sendWhatsApp(phone: string, text: string): Promise<void> {
  const key = Deno.env.get("WHATSAPP_PROVIDER_API_KEY");
  const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!key || !phoneId) throw new Error("WhatsApp not configured");
  let to = phone.replace(/[^0-9]/g, "");
  if (to.length === 10) to = `91${to}`; // default India country code
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 1000) } }),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
