/** Equivalent of Python's html.escape / html.unescape. */
export function escapeHtml(value: string, quote = true): string {
  let out = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (quote) {
    out = out.replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
  }
  return out;
}

const HTML_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&amp;": "&",
};

/**
 * Equivalent of Python's html.unescape for the entities escapeHtml produces.
 * Resolved in a single pass: sequential replacements would decode "&amp;lt;"
 * twice (to "<"), while html.unescape resolves it once (to "&lt;").
 */
export function unescapeHtml(value: string): string {
  return value.replace(/&(?:lt|gt|quot|#x27|#39|amp);/g, (entity) => HTML_ENTITIES[entity] as string);
}

/** JSON-encode for embedding inside a script block (Python: json.dumps(x).replace("</", "<\\/")). */
export function jsonForScript(value: unknown): string {
  // JSON.stringify returns undefined for undefined/functions/symbols; inside a
  // script block the JSON literal for those is `null`, not a crash.
  return (JSON.stringify(value) ?? "null").replaceAll("</", "<\\/");
}
