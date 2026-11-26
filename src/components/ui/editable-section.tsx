import { Pencil, X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card";

/**
 * Settings card that is read-only until the user taps Edit.
 * Save runs `onSave`; on success the card locks again. Cancel calls `onCancel`
 * (use it to reset the form to the saved values).
 */
export function EditableSection({
  title, description, children, onSave, onCancel, saving, className, canEdit = true, startEditing = false,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  onSave: () => Promise<unknown> | unknown;
  onCancel?: () => void;
  saving?: boolean;
  className?: string;
  canEdit?: boolean;
  startEditing?: boolean;
}) {
  const [editing, setEditing] = React.useState(startEditing);
  return (
    <Card className={cn(editing && "ring-2 ring-primary/40", className)}>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {canEdit && (editing ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => { onCancel?.(); setEditing(false); }}>
            <X /> Cancel
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil /> Edit
          </Button>
        ))}
      </CardHeader>
      <CardContent>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await onSave();
              setEditing(false);
            } catch {
              /* the caller shows the error; stay in edit mode */
            }
          }}
        >
          <fieldset disabled={!editing} className="min-w-0 space-y-4">{children}</fieldset>
          {editing && <Button type="submit" className="mt-5 w-full" loading={saving}>Save</Button>}
        </form>
      </CardContent>
    </Card>
  );
}
