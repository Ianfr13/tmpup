import { describe, expect, it } from "vitest";

import { guessContentType } from "../src/mime.js";

/**
 * Reference values produced by CPython 3.11:
 *   python3 -c "import mimetypes; print(mimetypes.guess_type('x.tar.gz'))"
 * app.py uses `mimetypes.guess_type(name)[0] or "application/octet-stream"`,
 * so a `None` type maps to the octet-stream fallback here.
 */
describe("guessContentType parity with mimetypes.guess_type", () => {
  it("unwraps compressed tar suffixes like Python", () => {
    expect(guessContentType("x.tar.gz")).toBe("application/x-tar");
    expect(guessContentType("x.tgz")).toBe("application/x-tar");
    expect(guessContentType("x.tar.bz2")).toBe("application/x-tar");
    expect(guessContentType("x.tbz2")).toBe("application/x-tar");
    expect(guessContentType("x.tar.xz")).toBe("application/x-tar");
  });

  it("keeps plain extension lookups", () => {
    expect(guessContentType("x.png")).toBe("image/png");
    expect(guessContentType("x.txt")).toBe("text/plain");
    expect(guessContentType("x.json")).toBe("application/json");
    expect(guessContentType("x.pdf")).toBe("application/pdf");
  });

  it("falls back to octet-stream where Python returns None", () => {
    expect(guessContentType(".png")).toBe("application/octet-stream");
    expect(guessContentType(".env")).toBe("application/octet-stream");
    expect(guessContentType("report.")).toBe("application/octet-stream");
    expect(guessContentType("x.unknownext")).toBe("application/octet-stream");
    expect(guessContentType("x.gz")).toBe("application/octet-stream");
    expect(guessContentType("a.b/c")).toBe("application/octet-stream");
    expect(guessContentType("dir/.env")).toBe("application/octet-stream");
  });
});
