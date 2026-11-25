/**
 * Bridges between the web build and the Android app (Capacitor).
 * Everything here degrades to normal browser behaviour on the website.
 */
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";

export const isNativeApp = Capacitor.isNativePlatform();

/**
 * Public website address. Inside the app, window.location is an internal
 * https://localhost origin, so links that leave the device (emails, invite
 * links, QR codes) must use the real site instead.
 */
export function siteUrl(): string {
  const configured = (import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined)?.replace(/\/$/, "");
  if (isNativeApp && configured) return configured;
  return window.location.origin;
}

/** One-time native setup: status bar colour, splash screen, Android back button. */
export function initNativeApp(goBack: () => void) {
  if (!isNativeApp) return;
  StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
  StatusBar.setBackgroundColor({ color: "#0b6bcb" }).catch(() => {});
  SplashScreen.hide().catch(() => {});
  App.addListener("backButton", ({ canGoBack }) => {
    // Close an open dialog first (Radix listens for Escape).
    const dialog = document.querySelector("[role=dialog]");
    if (dialog) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return;
    }
    if (canGoBack && window.location.pathname !== "/app" && window.location.pathname !== "/supplier" && window.location.pathname !== "/admin") goBack();
    else App.exitApp();
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Saves a generated file. On the website it downloads; in the Android app it
 * writes to the app cache and opens the share sheet (WhatsApp, Drive, Files…).
 */
export async function saveOrShareFile(blob: Blob, filename: string, title = filename): Promise<void> {
  if (isNativeApp) {
    const safeName = filename.replace(/[^\w.-]+/g, "_");
    const written = await Filesystem.writeFile({ path: safeName, data: await blobToBase64(blob), directory: Directory.Cache });
    await Share.share({ title, files: [written.uri], dialogTitle: title });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Opens a link outside the app (WhatsApp, payment pages, etc.). */
export async function openExternal(url: string) {
  if (isNativeApp) {
    if (url.startsWith("https://wa.me") || url.startsWith("whatsapp:")) {
      window.location.href = url; // let Android hand it to WhatsApp
      return;
    }
    await Browser.open({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
