import { Download, Sparkles } from "lucide-react";
import * as React from "react";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { formatSize, useAppUpdateCheck } from "@/lib/appUpdate";
import { openExternal } from "@/lib/native";

const DISMISS_KEY = "wd.updateDismissed";
export const SHOW_UPDATE_EVENT = "wd:show-update";

/** Clears a previous "Later" so the update dialog shows again (used by "Check for updates"). */
export function showUpdatePromptAgain() {
  try { localStorage.removeItem(DISMISS_KEY); } catch { /* ignore */ }
  window.dispatchEvent(new Event(SHOW_UPDATE_EVENT));
}

/** Shows "Update available" in the Android app; blocks the app when the update is mandatory. */
export function UpdatePrompt() {
  const { data } = useAppUpdateCheck();
  const [dismissed, setDismissed] = React.useState<number | null>(() => {
    try { return Number(localStorage.getItem(DISMISS_KEY)) || null; } catch { return null; }
  });
  React.useEffect(() => {
    const show = () => setDismissed(null);
    window.addEventListener(SHOW_UPDATE_EVENT, show);
    return () => window.removeEventListener(SHOW_UPDATE_EVENT, show);
  }, []);
  const latest = data?.latest;
  if (!latest) return null;

  const download = () => openExternal(latest.download_url);

  if (data.required) {
    return (
      <div className="safe-top fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <Logo size="lg" />
        <h1 className="text-xl font-bold">Please update Waterdrop</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Version {latest.version_name} is required to keep using the app. You have {data.installedName}.
        </p>
        {latest.notes && <p className="max-w-sm whitespace-pre-line rounded-xl bg-secondary p-3 text-left text-sm">{latest.notes}</p>}
        <Button size="lg" onClick={download}><Download /> Download update {formatSize(latest.file_size) && `(${formatSize(latest.file_size)})`}</Button>
        <p className="max-w-xs text-xs text-muted-foreground">After it downloads, open the file and tap Install. Your data stays safe.</p>
      </div>
    );
  }

  if (dismissed === latest.version_code) return null;
  const later = () => {
    try { localStorage.setItem(DISMISS_KEY, String(latest.version_code)); } catch { /* ignore */ }
    setDismissed(latest.version_code);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && later()}>
      <DialogContent title={`Update available: ${latest.version_name}`} description={`You have version ${data.installedName}.`}>
        <div className="flex items-start gap-3 rounded-xl bg-secondary p-3 text-sm">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <p className="whitespace-pre-line">{latest.notes || "Improvements and bug fixes."}</p>
        </div>
        <div className="mt-4 grid gap-2">
          <Button size="lg" onClick={() => { download(); later(); }}><Download /> Download update {formatSize(latest.file_size) && `(${formatSize(latest.file_size)})`}</Button>
          <Button variant="ghost" onClick={later}>Later</Button>
        </div>
        <p className="mt-3 text-center text-xs text-muted-foreground">After it downloads, open the file and tap Install. Your data stays safe.</p>
      </DialogContent>
    </Dialog>
  );
}
