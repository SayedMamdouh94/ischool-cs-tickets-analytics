import { config } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";

let loaded = false;

/**
 * Loads environment variables for the admin CLI, never overriding variables
 * already set in the shell.
 *
 *  - Default: .env.local then .env (local development).
 *  - ENV_FILE=<path>: load ONLY that file (e.g. ENV_FILE=.env.production.local
 *    to target production without touching the local configuration).
 */
export function loadEnv(): void {
  if (loaded) return;
  const explicit = process.env.ENV_FILE;
  if (explicit) {
    const full = path.resolve(process.cwd(), explicit);
    if (!existsSync(full)) {
      throw new Error(`ENV_FILE points to ${explicit}, which does not exist.`);
    }
    config({ path: full, override: false, quiet: true });
  } else {
    for (const file of [".env.local", ".env"]) {
      const full = path.resolve(process.cwd(), file);
      if (existsSync(full)) config({ path: full, override: false, quiet: true });
    }
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
