import { useQueryClient } from "@tanstack/react-query";
import { Crosshair, MapPin, Navigation, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { directionsUrl, formatAccuracy, getCurrentLocation, POOR_ACCURACY_M, type GeoPoint } from "@/lib/location";
import { openExternal } from "@/lib/native";
import { rpc } from "@/lib/supabase";
import type { Customer } from "@/types/db";

/** Shows a GPS warning when the fix is too rough to find the door. */
function AccuracyNote({ accuracy }: { accuracy: number | null | undefined }) {
  if (accuracy == null || accuracy <= POOR_ACCURACY_M) return null;
  return <p className="text-xs font-medium text-amber-700">GPS is rough ({formatAccuracy(accuracy)}). Try again outside for a better fix.</p>;
}

/** For forms (signup, add customer): capture the current location before saving. */
export function LocationPicker({ value, onChange, label = "Use my current location", hint }: {
  value: GeoPoint | null; onChange: (v: GeoPoint | null) => void; label?: string; hint?: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const capture = async () => {
    setBusy(true);
    try {
      const p = await getCurrentLocation();
      onChange(p);
      toast.success(`Location saved ${formatAccuracy(p.accuracy)}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (value) {
    return (
      <div className="space-y-1 rounded-xl bg-secondary p-3">
        <div className="flex flex-wrap items-center gap-2">
          <MapPin className="h-5 w-5 text-primary" />
          <span className="flex-1 text-sm font-semibold">Location captured {formatAccuracy(value.accuracy)}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => openExternal(directionsUrl(value.latitude, value.longitude))}>View map</Button>
          <Button type="button" size="sm" variant="ghost" aria-label="Remove location" onClick={() => onChange(null)}><Trash2 /></Button>
        </div>
        <AccuracyNote accuracy={value.accuracy} />
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Button type="button" variant="outline" className="w-full" loading={busy} onClick={capture}><Crosshair /> {label}</Button>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Saved delivery location of a branch: save / replace / remove, and directions. */
export function LocationCard({ customer, canEdit = true, forSupplier = false, onSaved }: {
  customer: Pick<Customer, "id" | "latitude" | "longitude" | "location_accuracy_m" | "location_updated_at">;
  canEdit?: boolean; forSupplier?: boolean; onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const has = customer.latitude != null && customer.longitude != null;
  const save = async (p: GeoPoint | null) => {
    setBusy(true);
    try {
      await rpc("set_customer_location", {
        p_customer_id: customer.id, p_latitude: p?.latitude ?? null, p_longitude: p?.longitude ?? null,
        p_accuracy_m: p?.accuracy == null ? null : Math.round(p.accuracy),
      });
      toast.success(p ? `Location saved ${formatAccuracy(p.accuracy)}` : "Location removed");
      qc.invalidateQueries({ queryKey: ["customer", customer.id] });
      qc.invalidateQueries({ queryKey: ["supplier-customers"] });
      onSaved?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const capture = async () => {
    const where = forSupplier ? "the customer's door" : "your delivery place";
    if (has && !confirm(`Replace the saved location with where you are now? Only do this at ${where}.`)) return;
    setBusy(true);
    try {
      const p = await getCurrentLocation();
      setBusy(false);
      await save(p);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><MapPin className="h-4 w-4 text-primary" /> Delivery location</CardTitle>
        <CardDescription>
          {has
            ? `Saved ${formatDate(customer.location_updated_at)} ${formatAccuracy(customer.location_accuracy_m)}`
            : forSupplier ? "Not saved yet. Save it when you are at the customer's door." : "Not saved yet. Save it while you are at the delivery place so the delivery person can find you."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <AccuracyNote accuracy={customer.location_accuracy_m} />
        <div className="grid gap-2 sm:grid-cols-2">
          {has && (
            <Button type="button" onClick={() => openExternal(directionsUrl(customer.latitude!, customer.longitude!))}>
              <Navigation /> {forSupplier ? "Directions" : "Open in Maps"}
            </Button>
          )}
          {canEdit && (
            <Button type="button" variant="outline" loading={busy} onClick={capture}>
              <Crosshair /> {has ? "Update to current location" : "Save current location"}
            </Button>
          )}
        </div>
        {has && canEdit && (
          <button type="button" className="text-xs text-muted-foreground underline" onClick={() => { if (confirm("Remove the saved location?")) save(null); }}>
            Remove location
          </button>
        )}
      </CardContent>
    </Card>
  );
}
