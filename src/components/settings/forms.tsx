"use client";

import { useActionState, useEffect, useTransition } from "react";
import { Loader2, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  changeRole,
  grantAccess,
  revokeAccess,
  savePreferences,
  saveProject,
  saveThresholds,
  type ActionResult,
} from "@/lib/settings/actions";
import type { AppUser, Settings } from "@/lib/analytics/types";
import { DATE_PRESET_LABELS } from "@/lib/filters/schema";
import { fmtDateTime } from "@/lib/format";

function useToastResult(state: ActionResult | null) {
  useEffect(() => {
    if (!state) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
  }, [state]);
}

export function ThresholdForm({ thresholds, disabled }: { thresholds: Settings["thresholds"]; disabled: boolean }) {
  const [state, action, pending] = useActionState(saveThresholds, null);
  useToastResult(state);
  const value = (k: string) => thresholds.find((t) => t.key === k)?.value_hours ?? "";
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      {thresholds.map((t) => (
        <div key={t.key} className="space-y-1.5">
          <Label htmlFor={t.key}>{t.label} (hours)</Label>
          <Input id={t.key} name={t.key} type="number" min={0.25} max={8760} step={0.25} defaultValue={value(t.key)} disabled={disabled} required />
          <p className="text-xs text-muted-foreground">{t.description}</p>
          <p className="text-[11px] text-muted-foreground">Last changed {fmtDateTime(t.updated_at)}</p>
        </div>
      ))}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={disabled || pending}>
          {pending && <Loader2 className="animate-spin" />} Save thresholds
        </Button>
      </div>
    </form>
  );
}

export function PreferencesForm({ app, disabled }: { app: Settings["app"]; disabled: boolean }) {
  const [state, action, pending] = useActionState(savePreferences, null);
  useToastResult(state);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-3">
      <div className="space-y-1.5">
        <Label htmlFor="organization_name">Organization name</Label>
        <Input id="organization_name" name="organization_name" defaultValue={app.organization_name ?? ""} maxLength={80} disabled={disabled} required />
      </div>
      <div className="space-y-1.5">
        <Label>Date presets end at</Label>
        <Select name="date_preset_anchor" defaultValue={app.date_preset_anchor ?? "dataset_end"} disabled={disabled}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dataset_end">Latest ticket in the data (recommended)</SelectItem>
            <SelectItem value="today">Today</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Historical exports end before today, so &ldquo;Last 30 days&rdquo; is anchored to the data by default.</p>
      </div>
      <div className="space-y-1.5">
        <Label>Default date range</Label>
        <Select name="default_date_preset" defaultValue={app.default_date_preset ?? "all"} disabled={disabled}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["all", "last_7", "last_30", "last_90", "this_month"] as const).map((p) => (
              <SelectItem key={p} value={p}>
                {DATE_PRESET_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="sm:col-span-3">
        <Button type="submit" disabled={disabled || pending}>
          {pending && <Loader2 className="animate-spin" />} Save preferences
        </Button>
      </div>
    </form>
  );
}

export function ProjectForm({ project, disabled }: { project: Settings["projects"][number]; disabled: boolean }) {
  const [state, action, pending] = useActionState(saveProject, null);
  useToastResult(state);
  return (
    <form action={action} className="grid items-end gap-3 rounded-lg border p-3 md:grid-cols-[1fr_1.4fr_1.2fr_5rem_auto_auto]">
      <input type="hidden" name="code" value={project.code} />
      <div className="text-sm">
        <p className="font-medium">{project.code}</p>
        <p className="text-xs text-muted-foreground">
          {project.program} · {project.intake} · org {project.organization_id} · {project.tickets.toLocaleString("en-US")} tickets
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`name-${project.code}`} className="text-xs">Display name</Label>
        <Input id={`name-${project.code}`} name="name" defaultValue={project.name} maxLength={120} disabled={disabled} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`hint-${project.code}`} className="text-xs">Export filename contains</Label>
        <Input id={`hint-${project.code}`} name="file_name_hint" defaultValue={project.file_name_hint} maxLength={120} disabled={disabled} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`order-${project.code}`} className="text-xs">Order</Label>
        <Input id={`order-${project.code}`} name="display_order" type="number" min={0} max={999} defaultValue={project.display_order} disabled={disabled} />
      </div>
      <div className="flex items-center gap-2 pb-2">
        <Switch id={`active-${project.code}`} name="is_active" defaultChecked={project.is_active} disabled={disabled} value="on" />
        <Label htmlFor={`active-${project.code}`} className="text-xs">Active</Label>
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={disabled || pending}>
        {pending && <Loader2 className="animate-spin" />} Save
      </Button>
    </form>
  );
}

export function AccessManager({ users, currentUserId, canInvite }: { users: AppUser[]; currentUserId: string; canInvite: boolean }) {
  const [state, action, pending] = useActionState(grantAccess, null);
  const [busy, startTransition] = useTransition();
  useToastResult(state);

  const run = (fn: () => Promise<ActionResult>) =>
    startTransition(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    });

  return (
    <div className="space-y-5">
      <form action={action} className="grid items-end gap-3 sm:grid-cols-[1fr_10rem_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="grant-email">Email</Label>
          <Input id="grant-email" name="email" type="email" placeholder="colleague@example.com" required />
        </div>
        <div className="space-y-1.5">
          <Label>Role</Label>
          <Select name="role" defaultValue="analyst">
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="analyst">Analyst</SelectItem>
              <SelectItem value="admin">Administrator</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />} Grant access
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Existing users receive the role immediately. {canInvite ? "New addresses receive an invitation email to set a password." : "Inviting new users requires SUPABASE_SECRET_KEY on the server; otherwise create the user in Supabase first."}{" "}
        Public sign-up is disabled. Analysts see aggregates and ticket metadata only — never message text, notes or attachments, and cannot export ticket rows.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table className="text-xs">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last sign-in</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.user_id}>
                <TableCell className="font-medium">
                  {u.email}
                  {u.user_id === currentUserId && <span className="ml-1.5 text-muted-foreground">(you)</span>}
                </TableCell>
                <TableCell>
                  {u.role ? (
                    <Select
                      value={u.role}
                      disabled={busy || u.user_id === currentUserId}
                      onValueChange={(v) => run(() => changeRole(u.email, v as "admin" | "analyst"))}
                    >
                      <SelectTrigger size="sm" className="h-7 w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="analyst">Analyst</SelectItem>
                        <SelectItem value="admin">Administrator</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="outline" className="font-normal">
                      No access
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="tabular">{fmtDateTime(u.last_sign_in_at)}</TableCell>
                <TableCell>{u.email_confirmed_at ? "Active" : u.invited_at ? "Invited" : "Unconfirmed"}</TableCell>
                <TableCell className="text-right">
                  {u.role && u.user_id !== currentUserId && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 text-destructive" disabled={busy}>
                          <ShieldOff /> Revoke
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Revoke access for {u.email}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            The account remains in Supabase but can no longer read any analytics data. You can grant a role again later.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => run(() => revokeAccess(u.user_id))}>Revoke access</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
