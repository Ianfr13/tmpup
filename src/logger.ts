/** Structured logging helper (svc=tmpup JSON line on stdout). */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  // The reserved keys come last so a caller field named svc/event cannot
  // overwrite the log line's own identity.
  console.log(
    JSON.stringify({
      ...fields,
      svc: "tmpup",
      event,
    }),
  );
}
