// Firebase Cloud Messaging (HTTP v1) with a Google service account.
// The service-account JSON lives only in the FCM_SERVICE_ACCOUNT Edge Function secret.

export interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri?: string }

export function readServiceAccount(raw: string | undefined | null): ServiceAccount | null {
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    return sa?.project_id && sa?.client_email && sa?.private_key ? sa : null;
  } catch {
    return null;
  }
}

const b64url = (bytes: Uint8Array | string) => {
  const bin = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

/** RS256-signed JWT assertion for Google's OAuth token endpoint. */
export async function signServiceJwt(sa: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600,
  }));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)));
  return `${header}.${claims}.${b64url(sig)}`;
}

let cached: { token: string; exp: number } | null = null;
export async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await signServiceJwt(sa) }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`google oauth failed: ${res.status} ${data.error ?? ""}`);
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cached.token;
}

/** Android channel: orders/requests ring loudly; everything else is normal. */
export function channelFor(type: string, severity: string) {
  if (["new_order", "account", "payment_submitted", "critical_stock"].includes(type) || severity === "critical") return "orders";
  return "general";
}

export function buildMessage(token: string, n: { title: string; message: string; link: string | null; notification_type: string; severity: string }) {
  return {
    message: {
      token,
      notification: { title: n.title, body: n.message },
      data: { link: n.link ?? "", type: n.notification_type },
      android: {
        priority: "HIGH",
        notification: { channel_id: channelFor(n.notification_type, n.severity), sound: "default", default_vibrate_timings: true },
      },
    },
  };
}

/** Sends to one device. Returns "ok", "invalid" (token should be deleted) or throws. */
export async function sendPush(sa: ServiceAccount, message: ReturnType<typeof buildMessage>): Promise<"ok" | "invalid"> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST", headers: { Authorization: `Bearer ${await accessToken(sa)}`, "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  if (res.ok) return "ok";
  const body = await res.text();
  // Token from another Firebase project (e.g. after switching projects) or app uninstalled: drop it.
  if (res.status === 404 || /UNREGISTERED|registration-token-not-registered|SENDER_ID_MISMATCH/.test(body)
      || (res.status === 400 && /INVALID_ARGUMENT/.test(body) && /token/i.test(body))) return "invalid";
  throw new Error(`fcm ${res.status}: ${body.replace(/\s+/g, " ").slice(0, 450)}`);
}
