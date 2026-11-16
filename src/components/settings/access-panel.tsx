"use client";

import { useMemo, useState, useTransition } from "react";
import { Loader2, Lock, Pencil, Plus, ShieldOff, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
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
import { PERMISSION_GROUPS, PERMISSIONS, scopeSummary, type PermissionDef } from "@/lib/auth/permissions";
import { deleteRole, grantAccess, revokeAccess, saveRole, updateAccess, type AccessInput } from "@/lib/settings/access-actions";
import type { ActionResult } from "@/lib/settings/actions";
import type { AppRoleSummary, AppUser } from "@/lib/analytics/types";
import { fmtDateTime } from "@/lib/format";

export interface AccessProject {
  code: string;
  name: string;
  program: string;
  status: string;
  cycle_name: string;
}

const CATALOG = PERMISSIONS as readonly PermissionDef[];
const GLOBAL_ONLY = CATALOG.filter((p) => p.allProjectsOnly).map((p) => p.key);

function useRunner() {
  const [busy, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, onOk?: () => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.message);
        onOk?.();
      } else toast.error(r.message);
    });
  return { busy, run };
}

/** Settings › Roles & access (administrators only; enforced by the server actions and PostgreSQL). */
export function AccessPanel({
  users,
  roles,
  projects,
  currentUserId,
  canInvite,
}: {
  users: AppUser[];
  roles: AppRoleSummary[];
  projects: AccessProject[];
  currentUserId: string;
  canInvite: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <UsersCard users={users} roles={roles} projects={projects} currentUserId={currentUserId} canInvite={canInvite} />
      <RolesCard roles={roles} />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Accounts
// -----------------------------------------------------------------------------

type AccessDialogState = { mode: "grant"; email?: string } | { mode: "edit"; user: AppUser } | null;

function UsersCard({
  users,
  roles,
  projects,
  currentUserId,
  canInvite,
}: {
  users: AppUser[];
  roles: AppRoleSummary[];
  projects: AccessProject[];
  currentUserId: string;
  canInvite: boolean;
}) {
  const [dialog, setDialog] = useState<AccessDialogState>(null);
  const { busy, run } = useRunner();

  return (
    <Card className="shadow-xs">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-sm font-semibold">Accounts</CardTitle>
          <CardDescription className="text-xs">
            Each account has one role (what it can do) and project access (which data it sees). Changes apply on the account&rsquo;s next page load.{" "}
            {canInvite ? "New addresses receive an invitation email to set a password." : "Inviting new users requires SUPABASE_SECRET_KEY on the server; otherwise create the user in Supabase first."}{" "}
            Public sign-up is disabled.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setDialog({ mode: "grant" })}>
          <UserPlus /> Add user
        </Button>
      </CardHeader>
      <CardContent className="px-0 sm:px-6">
        <div className="overflow-x-auto sm:rounded-lg sm:border">
          <Table className="text-xs">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Projects</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => {
                const self = u.user_id === currentUserId;
                return (
                  <TableRow key={u.user_id}>
                    <TableCell className="font-medium">
                      {u.email}
                      {self && <span className="ml-1.5 text-muted-foreground">(you)</span>}
                    </TableCell>
                    <TableCell>
                      {u.role ? (
                        <Badge variant={u.role === "admin" ? "default" : "secondary"} className="font-normal">
                          {u.role_name ?? u.role}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="font-normal">
                          No access
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="max-w-64 truncate" title={u.role ? scopeSummary({ allProjects: u.all_projects, programs: u.programs, projectCodes: u.project_codes }) : ""}>
                      {u.role ? scopeSummary({ allProjects: u.all_projects, programs: u.programs, projectCodes: u.project_codes }) : "—"}
                    </TableCell>
                    <TableCell className="tabular">{fmtDateTime(u.last_sign_in_at)}</TableCell>
                    <TableCell>{u.email_confirmed_at ? "Active" : u.invited_at ? "Invited" : "Unconfirmed"}</TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {!self && u.role && (
                        <Button variant="ghost" size="sm" className="h-7" disabled={busy} onClick={() => setDialog({ mode: "edit", user: u })}>
                          <Pencil /> Edit access
                        </Button>
                      )}
                      {!self && !u.role && (
                        <Button variant="ghost" size="sm" className="h-7" disabled={busy} onClick={() => setDialog({ mode: "grant", email: u.email })}>
                          <Plus /> Grant access
                        </Button>
                      )}
                      {!self && u.role && (
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
                                The account remains in Supabase but can no longer read any analytics data. You can grant access again later.
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
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      {dialog && (
        <AccessDialog
          key={dialog.mode === "edit" ? dialog.user.user_id : `grant-${dialog.email ?? ""}`}
          state={dialog}
          roles={roles}
          projects={projects}
          onClose={() => setDialog(null)}
        />
      )}
    </Card>
  );
}

function AccessDialog({
  state,
  roles,
  projects,
  onClose,
}: {
  state: NonNullable<AccessDialogState>;
  roles: AppRoleSummary[];
  projects: AccessProject[];
  onClose: () => void;
}) {
  const editing = state.mode === "edit" ? state.user : null;
  const [email, setEmail] = useState(editing?.email ?? (state.mode === "grant" ? (state.email ?? "") : ""));
  const [role, setRole] = useState(editing?.role ?? roles.find((r) => r.code === "analyst")?.code ?? roles[0]?.code ?? "");
  const [allProjects, setAllProjects] = useState(editing ? editing.all_projects : true);
  const [programs, setPrograms] = useState<string[]>(editing?.programs ?? []);
  const [projectCodes, setProjectCodes] = useState<string[]>(editing?.project_codes ?? []);
  const { busy, run } = useRunner();

  const selectedRole = roles.find((r) => r.code === role);
  const isAdminRole = role === "admin";
  const scopeAll = isAdminRole || allProjects;
  const globalOnlyInRole = (selectedRole?.permissions ?? []).filter((p) => GLOBAL_ONLY.includes(p));
  const byProgram = useMemo(() => {
    const m = new Map<string, AccessProject[]>();
    for (const p of projects) m.set(p.program, [...(m.get(p.program) ?? []), p]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [projects]);

  const toggle = (list: string[], value: string, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((v) => v !== value));

  const submit = () => {
    const input: AccessInput = { email: email.trim(), role, allProjects: scopeAll, programs: scopeAll ? [] : programs, projectCodes: scopeAll ? [] : projectCodes };
    run(() => (editing ? updateAccess(input) : grantAccess(input)), onClose);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit access for ${editing.email}` : "Add user"}</DialogTitle>
          <DialogDescription>The role decides which pages and actions the account can use; project access decides which data it sees.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="access-email">Email</Label>
            <Input id="access-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={Boolean(editing)} required placeholder="colleague@example.com" />
          </div>

          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a role" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.code} value={r.code}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedRole && <RolePermissionSummary role={selectedRole} />}
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Project access</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="scope" className="accent-primary" checked={scopeAll} onChange={() => setAllProjects(true)} />
              All projects, including future ones
            </label>
            <label className={`flex items-center gap-2 text-sm ${isAdminRole ? "opacity-50" : ""}`}>
              <input type="radio" name="scope" className="accent-primary" checked={!scopeAll} disabled={isAdminRole} onChange={() => setAllProjects(false)} />
              Only selected programs and projects
            </label>
            {isAdminRole && <p className="text-xs text-muted-foreground">Administrators always have access to all projects.</p>}

            {!scopeAll && (
              <div className="space-y-3 rounded-lg border p-3">
                {byProgram.map(([program, list]) => {
                  const wholeProgram = programs.includes(program);
                  return (
                    <div key={program} className="space-y-1.5">
                      <label className="flex items-start gap-2 text-sm font-medium">
                        <Checkbox className="mt-0.5" checked={wholeProgram} onCheckedChange={(v) => setPrograms((cur) => toggle(cur, program, v === true))} />
                        <span>
                          {program} — all projects
                          <span className="block text-xs font-normal text-muted-foreground">Includes projects of this program created later (new intakes and cycles).</span>
                        </span>
                      </label>
                      <div className="ml-6 grid gap-1 sm:grid-cols-2">
                        {list.map((p) => (
                          <label key={p.code} className={`flex items-start gap-2 text-xs ${wholeProgram ? "text-muted-foreground" : ""}`}>
                            <Checkbox
                              className="mt-0.5"
                              checked={wholeProgram || projectCodes.includes(p.code)}
                              disabled={wholeProgram}
                              onCheckedChange={(v) => setProjectCodes((cur) => toggle(cur, p.code, v === true))}
                            />
                            <span>
                              {p.name}
                              <span className="block text-[11px] text-muted-foreground">
                                {p.code} · {p.cycle_name}
                                {p.status === "archived" ? " · archived" : ""}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {byProgram.length === 0 && <p className="text-xs text-muted-foreground">No projects exist yet.</p>}
              </div>
            )}
            {!scopeAll && globalOnlyInRole.length > 0 && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
                {globalOnlyInRole.map((k) => CATALOG.find((p) => p.key === k)?.label).join(" and ")} only apply to accounts with access to all projects, so this
                account will not get {globalOnlyInRole.length === 1 ? "it" : "them"}.
              </p>
            )}
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !role || !email.trim()}>
              {busy && <Loader2 className="animate-spin" />} {editing ? "Save access" : "Grant access"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RolePermissionSummary({ role }: { role: AppRoleSummary }) {
  const granted = CATALOG.filter((p) => role.permissions.includes(p.key));
  if (granted.length === 0) return <p className="text-xs text-muted-foreground">This role grants no permissions yet.</p>;
  return (
    <div className="flex flex-wrap gap-1 pt-1" aria-label={`Permissions of ${role.name}`}>
      {granted.map((p) => (
        <Badge key={p.key} variant="outline" className="font-normal">
          {p.label}
        </Badge>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Roles
// -----------------------------------------------------------------------------

function RolesCard({ roles }: { roles: AppRoleSummary[] }) {
  const [editing, setEditing] = useState<AppRoleSummary | "new" | null>(null);
  const { busy, run } = useRunner();

  return (
    <Card className="shadow-xs">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-sm font-semibold">Roles</CardTitle>
          <CardDescription className="text-xs">
            A role is a set of permissions: the pages an account sees and the actions it may take. Permissions are enforced on the server and in PostgreSQL, not
            only hidden. Managing accounts and roles is reserved for Administrators.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          <Plus /> New role
        </Button>
      </CardHeader>
      <CardContent className="px-0 sm:px-6">
        <div className="overflow-x-auto sm:rounded-lg sm:border">
          <Table className="text-xs">
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Accounts</TableHead>
                <TableHead className="text-right">Permissions</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((r) => (
                <TableRow key={r.code}>
                  <TableCell>
                    <p className="font-medium">{r.name}</p>
                    <code className="text-[11px] text-muted-foreground">{r.code}</code>
                  </TableCell>
                  <TableCell className="max-w-96 text-muted-foreground">{r.description ?? "—"}</TableCell>
                  <TableCell className="tabular text-right">{r.users}</TableCell>
                  <TableCell className="tabular text-right">{r.editable ? `${r.permissions.length} of ${CATALOG.length}` : "All"}</TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {r.editable ? (
                      <Button variant="ghost" size="sm" className="h-7" disabled={busy} onClick={() => setEditing(r)}>
                        <Pencil /> Edit
                      </Button>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 text-muted-foreground">
                        <Lock className="size-3" /> Built in
                      </span>
                    )}
                    {!r.is_system && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-destructive"
                            disabled={busy || r.users > 0}
                            title={r.users > 0 ? "Give its accounts another role first" : undefined}
                          >
                            <Trash2 /> Delete
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete the {r.name} role?</AlertDialogTitle>
                            <AlertDialogDescription>No account uses it. This cannot be undone, but you can create the role again.</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => run(() => deleteRole(r.code))}>Delete role</AlertDialogAction>
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
      </CardContent>
      {editing && <RoleDialog key={editing === "new" ? "new" : editing.code} role={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

/** Lowercase code from a role name (editable; must match ^[a-z][a-z0-9_]{1,39}$). */
function codeFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/g, "")
    .slice(0, 40);
}

function RoleDialog({ role, onClose }: { role: AppRoleSummary | null; onClose: () => void }) {
  const [name, setName] = useState(role?.name ?? "");
  const [code, setCode] = useState(role?.code ?? "");
  const [codeTouched, setCodeTouched] = useState(Boolean(role));
  const [description, setDescription] = useState(role?.description ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const { busy, run } = useRunner();
  const effectiveCode = codeTouched ? code : codeFromName(name);

  const setMany = (keys: string[], on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const submit = () =>
    run(
      () => saveRole({ code: effectiveCode, name, description, permissions: [...selected], isNew: !role }),
      onClose,
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{role ? `Edit role: ${role.name}` : "New role"}</DialogTitle>
          <DialogDescription>
            Tick what accounts with this role may do. Pages that are not ticked disappear from their sidebar and cannot be opened.
            {role && role.users > 0 ? ` Changes apply to ${role.users} account(s).` : ""}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="role-name">Name</Label>
              <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="Support Lead" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role-code">Code</Label>
              <Input
                id="role-code"
                value={effectiveCode}
                onChange={(e) => {
                  setCodeTouched(true);
                  setCode(e.target.value.toLowerCase());
                }}
                disabled={Boolean(role)}
                required
                maxLength={40}
                pattern="[a-z][a-z0-9_]{1,39}"
                className="font-mono"
                placeholder="support_lead"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-description">Description (optional)</Label>
            <Textarea id="role-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} />
          </div>

          {PERMISSION_GROUPS.map((group) => {
            const items = CATALOG.filter((p) => p.group === group);
            const keys = items.map((p) => p.key);
            const on = keys.filter((k) => selected.has(k)).length;
            return (
              <fieldset key={group} className="space-y-2 rounded-lg border p-3">
                <legend className="px-1 text-sm font-medium">{group}</legend>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox checked={on === keys.length ? true : on > 0 ? "indeterminate" : false} onCheckedChange={(v) => setMany(keys, v === true)} />
                  Select all ({on}/{keys.length})
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {items.map((p) => {
                    const missing = p.requires && selected.has(p.key) && !selected.has(p.requires) ? CATALOG.find((x) => x.key === p.requires)?.label : null;
                    return (
                      <label key={p.key} className="flex items-start gap-2 text-sm">
                        <Checkbox className="mt-0.5" checked={selected.has(p.key)} onCheckedChange={(v) => setMany([p.key], v === true)} />
                        <span>
                          {p.label}
                          <span className="block text-xs text-muted-foreground">{p.description}</span>
                          {p.allProjectsOnly && <span className="block text-[11px] text-muted-foreground">Only for accounts with access to all projects.</span>}
                          {missing && <span className="block text-[11px] text-amber-700 dark:text-amber-400">Needs “{missing}” to be useful.</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
          {selected.has("export.tickets") && !selected.has("tickets.read_content") && (
            <p className="text-xs text-muted-foreground">Ticket-row exports will contain metadata only; the message-text export also needs “Read message text”.</p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !effectiveCode}>
              {busy && <Loader2 className="animate-spin" />} {role ? "Save role" : "Create role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
