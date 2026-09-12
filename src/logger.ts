/** Structured logging helper (svc=tmpup JSON line on stdout). */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      svc: "tmpup",
      event,
      ...fields,
    }),
  );
}
