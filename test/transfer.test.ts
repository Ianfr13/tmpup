/**
 * Starlette's FileResponse gave /d and /t byte ranges, validators and
 * conditional requests; app.py relied on that. These tests pin the behaviours
 * the raw createReadStream implementation has to reproduce, plus the hardening
 * added for scriptable content types.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authHeader, buildAuthenticatedServer, httpCall, makeDataDir, removeDataDir, restoreConfig, useApiKeys, TEST_API_KEY } from "./helpers.js";

let dataDir = "";

beforeEach(async () => {
  dataDir = await makeDataDir();
  useApiKeys(TEST_API_KEY);
});

afterEach(async () => {
  restoreConfig();
  await removeDataDir(dataDir);
  dataDir = "";
});

/** Upload `content` over a real socket and return the served file id. */
async function serve(filename: string, content: Buffer) {
  const app = await buildAuthenticatedServer();
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const upload = await httpCall(address + "/api/upload", {
    method: "POST",
    headers: {
      ...authHeader(),
      "x-filename": encodeURIComponent(filename),
      "x-ttl": "3600",
      "content-type": "application/octet-stream",
    },
    body: content,
  });
  expect(upload.status).toBe(200);
  const fileId = (JSON.parse(upload.body.toString("utf8")) as { id: string }).id;
  return { app, address, fileId };
}

describe("byte ranges and validators", () => {
  it("answers 206 with the requested slice and advertises ranges", async () => {
    const { app, address, fileId } = await serve("range.txt", Buffer.from("0123456789"));
    try {
      const partial = await httpCall(address + "/d/" + fileId + "/range.txt", {
        headers: { range: "bytes=2-5" },
      });
      expect(partial.status).toBe(206);
      expect(partial.headers["content-range"]).toBe("bytes 2-5/10");
      expect(partial.headers["accept-ranges"]).toBe("bytes");
      expect(partial.body.toString("utf8")).toBe("2345");

      const suffix = await httpCall(address + "/d/" + fileId + "/range.txt", {
        headers: { range: "bytes=-3" },
      });
      expect(suffix.status).toBe(206);
      expect(suffix.body.toString("utf8")).toBe("789");

      const invalid = await httpCall(address + "/d/" + fileId + "/range.txt", {
        headers: { range: "bytes=99-100" },
      });
      expect(invalid.status).toBe(416);
      expect(invalid.headers["content-range"]).toBe("bytes */10");
    } finally {
      await app.close();
    }
  });

  it("answers 304 when the client's validator still matches", async () => {
    const { app, address, fileId } = await serve("cache.txt", Buffer.from("cached"));
    try {
      const full = await httpCall(address + "/d/" + fileId + "/cache.txt");
      const etag = full.headers.etag as string;
      expect(etag).toBeTruthy();

      const notModified = await httpCall(address + "/d/" + fileId + "/cache.txt", {
        headers: { "if-none-match": etag },
      });
      expect(notModified.status).toBe(304);
      expect(notModified.body.length).toBe(0);

      const modifiedSince = await httpCall(address + "/d/" + fileId + "/cache.txt", {
        headers: { "if-modified-since": (full.headers["last-modified"] as string) ?? "" },
      });
      expect(modifiedSince.status).toBe(304);
    } finally {
      await app.close();
    }
  });

  it("normalizes repeated ?dl values like FastAPI did", async () => {
    const { app, address, fileId } = await serve("dl.txt", Buffer.from("dl"));
    try {
      const inline = await httpCall(address + "/d/" + fileId + "/dl.txt?dl=0");
      expect(inline.headers["content-disposition"]).toBe("inline");

      // ?dl=1&dl=0 keeps the first value (attachment) instead of crashing.
      const forced = await httpCall(address + "/d/" + fileId + "/dl.txt?dl=1&dl=0");
      expect(forced.status).toBe(200);
      expect(String(forced.headers["content-disposition"])).toContain("attachment");
    } finally {
      await app.close();
    }
  });
});

describe("scriptable inline uploads are sandboxed", () => {
  it("adds nosniff + CSP sandbox to inline HTML and SVG", async () => {
    const fixtures: [string, Buffer][] = [
      ["evil.html", Buffer.from("<script>alert(1)</script>")],
      ["evil.svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")],
    ];
    for (const [filename, content] of fixtures) {
      const { app, address, fileId } = await serve(filename, content);
      try {
        const res = await httpCall(address + "/d/" + fileId + "/" + filename);
        expect(res.status).toBe(200);
        expect(res.headers["content-disposition"]).toBe("inline");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["content-security-policy"]).toBe("sandbox");

        // Forcing a download keeps the headers off (it is not rendered inline).
        const forced = await httpCall(address + "/d/" + fileId + "/" + filename + "?dl=1");
        expect(String(forced.headers["content-disposition"])).toContain("attachment");
        expect(forced.headers["content-security-policy"]).toBeUndefined();
      } finally {
        await app.close();
      }
    }
  });

  it("does not add the sandbox to harmless inline types", async () => {
    const { app, address, fileId } = await serve("notes.txt", Buffer.from("hello"));
    try {
      const res = await httpCall(address + "/d/" + fileId + "/notes.txt");
      expect(res.headers["content-disposition"]).toBe("inline");
      expect(res.headers["content-security-policy"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
