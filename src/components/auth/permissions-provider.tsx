"use client";

import { createContext, use } from "react";

/**
 * Streams the viewer's effective permissions from the dashboard layout to
 * client components (sidebar, chart download buttons) without blocking the
 * layout. Only decides what is SHOWN: pages, route handlers, server actions
 * and PostgreSQL enforce every permission themselves.
 */
const PermissionsContext = createContext<Promise<readonly string[]> | null>(null);

export function PermissionsProvider({ permissions, children }: { permissions: Promise<readonly string[]>; children: React.ReactNode }) {
  return <PermissionsContext value={permissions}>{children}</PermissionsContext>;
}

const NONE: readonly string[] = [];

/** The viewer's permissions (suspends until known). Fails closed without a provider. */
export function usePermissions(): readonly string[] {
  const promise = use(PermissionsContext);
  return promise ? use(promise) : NONE;
}
