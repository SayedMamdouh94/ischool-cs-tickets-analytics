/** Only allow same-origin relative redirects (prevents open redirects). */
export function safeNext(next: unknown, fallback = "/overview"): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}
