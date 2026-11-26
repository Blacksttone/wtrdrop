import { App } from "@capacitor/app";
import { useQuery } from "@tanstack/react-query";
import { isNativeApp } from "./native";
import { supabase } from "./supabase";

export interface AppRelease {
  id: string;
  version_code: number;
  version_name: string;
  download_url: string;
  file_size: number | null;
  notes: string | null;
  mandatory: boolean;
  published: boolean;
  created_at: string;
}

export async function fetchLatestRelease(): Promise<AppRelease | null> {
  const { data, error } = await supabase.rpc("latest_app_release", { p_platform: "android" });
  if (error) throw error;
  const r = data as AppRelease | null;
  return r && r.id ? r : null;
}

/** Latest published APK (used by the website download button). */
export const useLatestRelease = () =>
  useQuery({ queryKey: ["latest-release"], queryFn: fetchLatestRelease, staleTime: 10 * 60_000, retry: false });

/** In the Android app: is a newer version published, and must the user install it? */
export function useAppUpdateCheck() {
  return useQuery({
    queryKey: ["app-update-check"],
    enabled: isNativeApp,
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
    queryFn: async () => {
      const info = await App.getInfo();
      const installed = Number(info.build) || 0;
      const latest = await fetchLatestRelease();
      if (!latest || latest.version_code <= installed) return { installed, installedName: info.version, latest: null, required: false };
      const { data: required } = await supabase.rpc("app_update_required", { p_platform: "android", p_installed_version_code: installed });
      return { installed, installedName: info.version, latest, required: Boolean(required) };
    },
  });
}

export const formatSize = (bytes: number | null | undefined) => (bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "");
