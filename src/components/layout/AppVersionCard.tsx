import { RefreshCw, Smartphone } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAppUpdateCheck } from "@/lib/appUpdate";
import { isNativeApp } from "@/lib/native";
import { showUpdatePromptAgain } from "./UpdatePrompt";

/** Settings row in the Android app: installed version + "Check for updates". */
export function AppVersionCard() {
  const check = useAppUpdateCheck();
  const [busy, setBusy] = React.useState(false);
  if (!isNativeApp) return null;
  const run = async () => {
    setBusy(true);
    try {
      const { data, error } = await check.refetch();
      if (error) throw error;
      if (data?.latest) showUpdatePromptAgain();
      else toast.success(`You have the latest version (${data?.installedName ?? ""})`);
    } catch {
      toast.error("Could not check for updates. Check your internet and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <Smartphone className="h-5 w-5 text-primary" />
        <div className="flex-1">
          <p className="text-sm font-semibold">App version {check.data?.installedName ?? "…"}</p>
          {check.data?.latest && <p className="text-xs font-medium text-primary">Version {check.data.latest.version_name} is available</p>}
        </div>
        <Button size="sm" variant="outline" loading={busy} onClick={run}><RefreshCw /> Check for updates</Button>
      </CardContent>
    </Card>
  );
}
