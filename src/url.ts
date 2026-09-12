/**
 * URL helpers matching Python's `urllib.parse` behaviour used by app.py.
 */

/**
 * `urllib.parse.quote(value, safe=safe)`: always-safe chars are A-Za-z0-9_.-~
 * and, like Python's default, `/`. Pass `safe=""` to encode slashes too
 * (app.py's Content-Disposition does exactly that).
 */
export function pythonQuote(value: string, safe = "/"): string {
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
  let out = "";
  const bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length === 0) return;
    const buf = Buffer.from(bytes);
    // Decode as UTF-8, replacing invalid sequences with U+FFFD. ignoreBOM keeps a
    // leading U+FEFF (Python's bytes.decode does not strip it either).
    out += new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buf);
    bytes.length = 0;
  };
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] as string;
    if (char === "%" && i + 3 <= value.length) {
      const hex = value.slice(i + 1, i + 3);
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
