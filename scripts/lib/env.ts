import { config } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";

let loaded = false;

/** Loads .env.local then .env (never overriding variables already set in the shell). */
export function loadEnv(): void {
  if (loaded) return;
  for (const file of [".env.local", ".env"]) {
    const full = path.resolve(process.cwd(), file);
    if (existsSync(full)) config({ path: full, override: false, quiet: true });
  }
  loaded = true;
}

export function requireEnv(name: string, hint?: string): string {
  loadEnv();
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing environment variable ${name}.${hint ? ` ${hint}` : ""}`);
  }
  return value.trim();
}

export function optionalEnv(name: string): string | undefined {
  loadEnv();
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}
