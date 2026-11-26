import { useQuery } from "@tanstack/react-query";
import { Smartphone, Trash2, Upload } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Switch, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { type AppRelease, formatSize } from "@/lib/appUpdate";
import { errorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { supabase } from "@/lib/supabase";

export default function AppUpdates() {
  const { session } = useAuth();
  const releases = useQuery({
    queryKey: ["app-releases"],
    queryFn: async () => {
      const { data, error } = await supabase.from("app_releases").select("*").order("version_code", { ascending: false });
      if (error) throw error;
      return data as (AppRelease & { file_path: string | null })[];
    },
  });
  const latestCode = releases.data?.[0]?.version_code ?? 0;
  const [file, setFile] = React.useState<File | null>(null);
  const [f, setF] = React.useState({ name: "", code: "", notes: "", mandatory: false });
  const [uploading, setUploading] = React.useState(false);
  const [progress, setProgress] = React.useState("");

  async function publish(e: React.FormEvent) {
    e.preventDefault();
    const code = Number(f.code);
    if (!file) return toast.error("Choose the APK file");
    if (!file.name.toLowerCase().endsWith(".apk")) return toast.error("The file must be an .apk");
    if (!/^\d+(\.\d+){0,3}$/.test(f.name.trim())) return toast.error("Version name looks like 1.0.3");
    if (!(code > latestCode)) return toast.error(`Version code must be higher than ${latestCode}`);
    setUploading(true);
    try {
      const path = `android/waterdrop-${f.name.trim()}-${code}.apk`;
      setProgress(`Uploading ${formatSize(file.size)}…`);
      const up = await supabase.storage.from("app-releases").upload(path, file, {
        upsert: true, contentType: "application/vnd.android.package-archive",
      });
      if (up.error) throw up.error;
      const url = supabase.storage.from("app-releases").getPublicUrl(path).data.publicUrl;
      setProgress("Publishing…");
      const { error } = await supabase.from("app_releases").insert({
        version_code: code, version_name: f.name.trim(), download_url: url, file_path: path, file_size: file.size,
        notes: f.notes.trim() || null, mandatory: f.mandatory, created_by: session?.user.id,
      });
      if (error) throw error;
      toast.success(`Version ${f.name} published. Users will see the update next time they open the app.`);
      setFile(null);
      setF({ name: "", code: "", notes: "", mandatory: false });
      releases.refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
      setProgress("");
    }
  }

  const patch = useAction(async (v: { id: string; values: Partial<AppRelease> }) => {
    const { error } = await supabase.from("app_releases").update(v.values).eq("id", v.id);
    if (error) throw error;
  }, { success: "Release updated", invalidate: [["app-releases"]] });
  const remove = useAction(async (r: AppRelease & { file_path: string | null }) => {
    if (r.file_path) await supabase.storage.from("app-releases").remove([r.file_path]);
    const { error } = await supabase.from("app_releases").delete().eq("id", r.id);
    if (error) throw error;
  }, { success: "Release deleted", invalidate: [["app-releases"]] });

  return (
    <div className="space-y-5">
      <PageHeader title="App updates" description="Publish a new Android APK. Installed apps show an update prompt automatically." />
      <Card>
        <CardHeader>
          <CardTitle>Publish a new version</CardTitle>
          <CardDescription>Use the version name and code given with the APK (for example 1.0.3 and 4). The code must always go up.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={publish} className="grid gap-4 sm:grid-cols-2">
            <Field label="APK file" htmlFor="apk" className="sm:col-span-2">
              <label htmlFor="apk" className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed p-3 text-sm hover:bg-secondary">
                <Upload className="h-4 w-4" /> {file ? `${file.name} (${formatSize(file.size)})` : "Choose .apk file"}
              </label>
              <input id="apk" type="file" accept=".apk,application/vnd.android.package-archive" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <Field label="Version name" htmlFor="vn"><Input id="vn" placeholder="1.0.3" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Version code" htmlFor="vc" hint={`Last published: ${latestCode || "none"}`}>
              <Input id="vc" type="number" min={latestCode + 1} placeholder={String(latestCode + 1)} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
            </Field>
            <Field label="What's new (shown to users)" htmlFor="vnotes" className="sm:col-span-2">
              <Textarea id="vnotes" maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="• QR scan&#10;• Bug fixes" />
            </Field>
            <div className="flex items-center justify-between rounded-xl bg-secondary p-3 sm:col-span-2">
              <div>
                <p className="text-sm font-semibold">Compulsory update</p>
                <p className="text-xs text-muted-foreground">Older versions cannot be used until they update. Use only for important fixes.</p>
              </div>
              <Switch id="mand" label="Compulsory update" checked={f.mandatory} onChange={(v) => setF({ ...f, mandatory: v })} />
            </div>
            <Button type="submit" className="sm:col-span-2" loading={uploading}>{uploading ? progress : "Upload & publish"}</Button>
          </form>
        </CardContent>
      </Card>
      {releases.isLoading ? <LoadingState rows={2} /> : releases.error ? <ErrorState error={releases.error} onRetry={releases.refetch} /> : !releases.data?.length ? (
        <EmptyState icon={Smartphone} title="No versions published yet" description="Upload the APK you installed so the website download button and update checks work." />
      ) : (
        <Card className="divide-y">
          {releases.data.map((r, i) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="font-semibold">Version {r.version_name} <span className="text-xs font-normal text-muted-foreground">(code {r.version_code}) · {formatSize(r.file_size)}</span></p>
                <p className="text-xs text-muted-foreground">{formatDateTime(r.created_at)}</p>
                {r.notes && <p className="mt-1 whitespace-pre-line text-sm">{r.notes}</p>}
                <div className="mt-1 flex gap-1">
                  {i === 0 && r.published && <Badge variant="success">Latest</Badge>}
                  {!r.published && <Badge variant="muted">Hidden</Badge>}
                  {r.mandatory && <Badge variant="danger">Compulsory</Badge>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" asChild><a href={r.download_url}>Download</a></Button>
                <Button size="sm" variant="outline" onClick={() => patch.mutate({ id: r.id, values: { published: !r.published } })}>{r.published ? "Hide" : "Publish"}</Button>
                <Button size="sm" variant="outline" onClick={() => patch.mutate({ id: r.id, values: { mandatory: !r.mandatory } })}>{r.mandatory ? "Make optional" : "Make compulsory"}</Button>
                <Button size="sm" variant="ghost" aria-label="Delete release" onClick={() => { if (confirm(`Delete version ${r.version_name}?`)) remove.mutate(r); }}><Trash2 /></Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
