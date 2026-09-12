/** Equivalent of Python's `html.escape`. */
export function escapeHtml(value: string, quote = true): string {
  let out = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (quote) {
    out = out.replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
  }
  return out;
}

/** Equivalent of Python's `html.unescape` for the entities escapeHtml produces. */
export function unescapeHtml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/** JSON-encode for embedding inside a script block (Python: json.dumps(x).replace("</", "<\/")). */
export function jsonForScript(value: unknown): string {
  // JSON.stringify returns undefined for undefined/functions/symbols; inside a
  // script block the JSON literal for those is `null`, not a crash.
  return (JSON.stringify(value) ?? "null").replaceAll("</", "<\\/");
}
