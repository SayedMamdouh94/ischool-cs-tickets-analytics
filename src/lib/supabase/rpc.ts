import type { SupabaseClient } from "@supabase/supabase-js";

export interface RpcResult<T> {
  data: T;
  error: { message: string; code?: string } | null;
}

/**
 * Calls a SQL function by name. The analytics functions return jsonb, which the
 * generated types describe as `Json`; callers supply the precise payload type.
 * (Invokes `client.rpc` as a method so its `this` binding is preserved.)
 */
export async function callRpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<RpcResult<T>> {
  const { data, error } = await (client as unknown as { rpc: (f: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcResult<T>["error"] }> }).rpc(fn, args);
  return { data: data as T, error };
}
