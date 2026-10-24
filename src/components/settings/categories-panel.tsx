"use client";

import { useActionState, useMemo, useState, useTransition } from "react";
import { Loader2, Plus, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { mapTopic, saveCategory, setStatusClass, type ActionResult } from "@/lib/settings/actions";
import type { StatusValue, TopicMappings } from "@/lib/analytics/types";
import { fmtInt } from "@/lib/format";

const UNMAPPED = "__unmapped__";

export function CategoriesPanel({ mappings, statuses, isAdmin }: { mappings: TopicMappings; statuses: StatusValue[]; isAdmin: boolean }) {
  const [query, setQuery] = useState("");
  const [onlyNew, setOnlyNew] = useState(false);
  const categories = mappings.categories.filter((c) => c.kind === "category" && c.is_active);
  const unmapped = mappings.topics.filter((t) => !t.mapped && t.tickets > 0);
  const topics = useMemo(
    () => mappings.topics.filter((t) => (!onlyNew || !t.mapped) && t.topic.toLowerCase().includes(query.trim().toLowerCase())),
    [mappings.topics, onlyNew, query],
  );
  const unclassified = statuses.filter((s) => !s.configured && s.tickets > 0);

  return (
    <div className="flex flex-col gap-4">
      <Card className="shadow-xs">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              Topic → category mapping
              {unmapped.length > 0 && (
                <Badge variant="outline" className="border-amber-500/50 font-normal text-amber-800 dark:text-amber-300">
                  {unmapped.length} new topic{unmapped.length === 1 ? "" : "s"} to review
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              Source topics are grouped into analytical categories. Unmapped topics count as &quot;Uncategorized&quot;. Changing a mapping reclassifies every ticket with that topic
              immediately; the original Topic is never changed.
            </CardDescription>
          </div>
          {isAdmin && <CategoryDialog />}
        </CardHeader>
        <CardContent className="space-y-3 px-0 sm:px-6">
          <div className="flex flex-wrap items-center gap-2 px-6 sm:px-0">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search topics" className="h-9 pl-8" />
            </div>
            <Button size="sm" variant={onlyNew ? "default" : "outline"} onClick={() => setOnlyNew((v) => !v)}>
              <Sparkles /> Unmapped only
            </Button>
          </div>
          <div className="max-h-[560px] overflow-auto sm:rounded-lg sm:border">
            <Table className="text-xs">
              <TableHeader className="sticky top-0 bg-muted">
                <TableRow>
                  <TableHead>Source topic</TableHead>
                  <TableHead className="text-right">Tickets</TableHead>
                  <TableHead className="text-right">Current cycle</TableHead>
                  <TableHead>Projects</TableHead>
                  <TableHead className="w-64">Category</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topics.map((t) => (
                  <TopicRow key={t.topic} topic={t} categories={categories} isAdmin={isAdmin} />
                ))}
                {topics.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      No topics match.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            Status values: open or closed
            {unclassified.length > 0 && (
              <Badge variant="outline" className="border-amber-500/50 font-normal text-amber-800 dark:text-amber-300">
                {unclassified.length} unclassified
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="text-xs">
            Backlog figures count a ticket as open when it has no resolution time and its status is classified as open. Unclassified statuses are counted as open (so they are never
            hidden) and flagged until you classify them.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          <div className="overflow-x-auto sm:rounded-lg sm:border">
            <Table className="text-xs">
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead>Status value</TableHead>
                  <TableHead className="text-right">Tickets</TableHead>
                  <TableHead className="w-48">Counts as</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statuses.map((s) => (
                  <StatusRow key={s.status} status={s} isAdmin={isAdmin} />
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TopicRow({ topic, categories, isAdmin }: { topic: TopicMappings["topics"][number]; categories: TopicMappings["categories"]; isAdmin: boolean }) {
  const [pending, start] = useTransition();
  const value = topic.category ?? UNMAPPED;
  const change = (v: string) =>
    start(async () => {
      const r = await mapTopic(topic.topic, v === UNMAPPED ? null : v);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    });
  return (
    <TableRow>
      <TableCell className="max-w-[28rem]">
        <span dir="auto" className="user-text font-medium">
          {topic.topic}
        </span>
        {!topic.mapped && topic.tickets > 0 && (
          <Badge variant="outline" className="ml-2 border-amber-500/50 font-normal text-amber-800 dark:text-amber-300">
            New
          </Badge>
        )}
      </TableCell>
      <TableCell className="tabular text-right">{fmtInt(topic.tickets)}</TableCell>
      <TableCell className="tabular text-right">{fmtInt(topic.current_cycle_tickets)}</TableCell>
      <TableCell className="text-muted-foreground">{topic.projects.join(", ") || "—"}</TableCell>
      <TableCell>
        {isAdmin ? (
          <div className="flex items-center gap-2">
            <Select value={value} onValueChange={change} disabled={pending}>
              <SelectTrigger size="sm" className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNMAPPED}>Uncategorized (not mapped)</SelectItem>
                {categories
                  .filter((c) => c.code !== "uncategorized")
                  .map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
          </div>
        ) : (
          (topic.category_name ?? "Uncategorized")
        )}
      </TableCell>
    </TableRow>
  );
}

function StatusRow({ status, isAdmin }: { status: StatusValue; isAdmin: boolean }) {
  const [pending, start] = useTransition();
  const label = status.status === "__none__" ? "(missing status)" : status.status;
  return (
    <TableRow>
      <TableCell className="font-medium">
        {label}
        {!status.configured && (
          <Badge variant="outline" className="ml-2 border-amber-500/50 font-normal text-amber-800 dark:text-amber-300">
            Unclassified — counted as open
          </Badge>
        )}
      </TableCell>
      <TableCell className="tabular text-right">{fmtInt(status.tickets)}</TableCell>
      <TableCell>
        {isAdmin ? (
          <div className="flex items-center gap-2">
            <Select
              value={status.class ?? ""}
              disabled={pending}
              onValueChange={(v) =>
                start(async () => {
                  const r = await setStatusClass(status.status, v as "open" | "closed");
                  if (r.ok) toast.success(r.message);
                  else toast.error(r.message);
                })
              }
            >
              <SelectTrigger size="sm" className="h-8 w-full">
                <SelectValue placeholder="Choose…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open (backlog)</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
          </div>
        ) : status.class ? (
          status.class === "open" ? "Open" : "Closed"
        ) : (
          "Unclassified"
        )}
      </TableCell>
    </TableRow>
  );
}

function CategoryDialog() {
  const [open, setOpen] = useState(false);
  const [, action, pending] = useActionState<ActionResult | null, FormData>(async (prev, fd) => {
    const r = await saveCategory(prev, fd);
    if (r.ok) {
      toast.success(r.message);
      setOpen(false);
    } else toast.error(r.message);
    return r;
  }, null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> New category
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New analytical category</DialogTitle>
          <DialogDescription>Categories group related source topics on the Topics page and in filters.</DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cat-name">English name</Label>
              <Input id="cat-name" name="name_en" required maxLength={120} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cat-name-ar">Arabic name (optional)</Label>
              <Input id="cat-name-ar" name="name_ar" dir="rtl" maxLength={120} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-code">Code</Label>
            <Input id="cat-code" name="code" required maxLength={60} className="font-mono lowercase" placeholder="certificates_requests" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-desc">Description (optional)</Label>
            <Input id="cat-desc" name="description" maxLength={500} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Create category
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
