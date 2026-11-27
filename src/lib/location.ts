import { Geolocation } from "@capacitor/geolocation";
import { isNativeApp } from "./native";

export interface GeoPoint { latitude: number; longitude: number; accuracy: number | null }

export class LocationError extends Error {}

/** Reads the phone's current GPS position (asks for permission the first time). */
export async function getCurrentLocation(): Promise<GeoPoint> {
  const opts = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 };
  try {
    if (isNativeApp) {
      const perm = await Geolocation.checkPermissions();
      if (perm.location !== "granted") {
        const asked = await Geolocation.requestPermissions({ permissions: ["location"] });
        if (asked.location !== "granted") throw new LocationError("Location permission was denied. Allow it in your phone settings for Waterdrop.");
      }
      const p = await Geolocation.getCurrentPosition(opts);
      return { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy ?? null };
    }
    if (!("geolocation" in navigator)) throw new LocationError("This browser cannot share your location.");
    const p = await new Promise<GeolocationPosition>((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, opts));
    return { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy ?? null };
  } catch (e) {
    if (e instanceof LocationError) throw e;
    const code = (e as { code?: number | string }).code;
    const msg = String((e as Error)?.message ?? "");
    if (code === 1 || /denied|permission/i.test(msg)) throw new LocationError("Location permission was denied. Allow location for Waterdrop and try again.");
    if (code === 3 || /timeout/i.test(msg)) throw new LocationError("Could not get a GPS fix. Go outside or near a window and try again.");
    throw new LocationError("Could not get your location. Turn on GPS / location and try again.");
  }
}

/** Google Maps directions to a point (opens the Maps app on Android). */
export function directionsUrl(lat: number, lng: number) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function formatAccuracy(m: number | null | undefined) {
  if (m == null) return "";
  return m < 1000 ? `±${Math.round(m)} m` : `±${(m / 1000).toFixed(1)} km`;
}

/** Accuracy worse than this is probably not the exact door. */
export const POOR_ACCURACY_M = 100;
