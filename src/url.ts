/**
 * URL helpers matching Python's `urllib.parse` behaviour used by app.py.
 */

/** `urllib.parse.quote(value, safe=safe)`: always-safe chars are A-Za-z0-9_.-~ . */
export function pythonQuote(value: string, safe = ""): string {
  const alwaysSafe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~";
  const safeSet = new Set((alwaysSafe + safe).split(""));
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (byte < 0x80 && safeSet.has(char)) {
      out += char;
    } else {
      out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/**
 * `urllib.parse.unquote`: percent-decodes UTF-8, replacing invalid sequences
 * instead of throwing (unlike `decodeURIComponent`).
 */
export function pythonUnquote(value: string): string {
  // NOTE: unlike unquote_plus, urllib.parse.unquote leaves '+' untouched.
  const replaced = value;
  let out = "";
  const bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length === 0) return;
    const buf = Buffer.from(bytes);
    // Decode as UTF-8, replacing invalid sequences with U+FFFD.
    out += new TextDecoder("utf-8", { fatal: false }).decode(buf);
    bytes.length = 0;
  };
  for (let i = 0; i < replaced.length; i += 1) {
    const char = replaced[i] as string;
    if (char === "%" && i + 2 < replaced.length + 0) {
      const hex = replaced.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    flush();
    out += char;
  }
  flush();
  return out;
}

/** `int(value)` for the ASCII header values app.py parses. */
export function pythonInt(value: string): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`invalid literal for int(): '${value}'`);
  }
  return Number.parseInt(trimmed, 10);
}
