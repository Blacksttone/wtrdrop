import { PushNotifications } from "@capacitor/push-notifications";
import { isNativeApp } from "./native";
import { supabase } from "./supabase";

const TOKEN_KEY = "wd.pushToken";
export const pushAvailable = isNativeApp && __PUSH_ENABLED__;

let listenersReady = false;

/**
 * Asks for notification permission and registers this phone for push
 * notifications for the logged-in user. Safe to call on every login.
 * `onOpen` is called with the in-app link when a notification is tapped.
 */
export async function enablePush(onOpen: (link: string) => void): Promise<"on" | "denied" | "off"> {
  if (!pushAvailable) return "off";
  if (!listenersReady) {
    listenersReady = true;
    await PushNotifications.createChannel({ id: "orders", name: "Orders & requests", description: "New orders and customer requests", importance: 5, sound: "default", vibration: true, visibility: 1 });
    await PushNotifications.createChannel({ id: "general", name: "Updates", description: "Deliveries, bills and reminders", importance: 3, vibration: true, visibility: 1 });
    await PushNotifications.addListener("registration", async ({ value }) => {
      try { localStorage.setItem(TOKEN_KEY, value); } catch { /* ignore */ }
      await supabase.rpc("register_push_token", { p_token: value, p_platform: "android" });
    });
    await PushNotifications.addListener("registrationError", (e) => console.warn("push registration failed", e.error));
    await PushNotifications.addListener("pushNotificationActionPerformed", ({ notification }) => {
      const link = (notification.data as { link?: string } | undefined)?.link;
      if (link && link.startsWith("/")) onOpen(link);
    });
  }
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") perm = await PushNotifications.requestPermissions();
  if (perm.receive !== "granted") return "denied";
  await PushNotifications.register();
  return "on";
}

/** On logout: stop sending this user's notifications to this phone. */
export async function disablePush() {
  if (!pushAvailable) return;
  let token: string | null = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch { /* ignore */ }
  if (token) await supabase.rpc("unregister_push_token", { p_token: token });
}
