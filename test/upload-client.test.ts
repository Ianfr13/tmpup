import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function client(failFirstChunk = false) {
  const template = readFileSync(new URL("../src/templates/list.html", import.meta.url), "utf8");
  const source = template.slice(template.indexOf("  function uploadRequest("), template.indexOf("  async function uploadOne("));
  const calls: { method: string; url: string; body: any }[] = [];
  let failed = false;
  class XHR {
    status = 200; responseText = "{}"; method = ""; url = "";
    callbacks: Record<string, Function> = {};
    upload = { addEventListener() {} };
    open(method: string, url: string) { this.method = method; this.url = url; }
    setRequestHeader() {}
    addEventListener(name: string, cb: Function) { this.callbacks[name] = cb; }
    send(body: any) {
      calls.push({ method: this.method, url: this.url, body });
      if (this.method === "PUT" && failFirstChunk && !failed) { failed = true; this.callbacks.error!(); return; }
      if (this.url === "/api/uploads") this.responseText = JSON.stringify({ upload_id: "test", chunk_size: 8 * 1024 * 1024 });
      else if (this.method === "PUT") this.responseText = JSON.stringify({ offset: Number(this.url.split("offset=")[1]) + body.size });
      this.callbacks.load!();
    }
  }
  const context = vm.createContext({ XMLHttpRequest: XHR, setTimeout: (fn: Function) => fn(), Promise, JSON, Error, Math, Number, encodeURIComponent });
  vm.runInContext(source, context);
  return { context, calls };
}
describe("browser chunk uploads", () => {
  it("splits a large video into bounded sequential requests", async () => {
    const { context, calls } = client();
    const file = { name: "video.mp4", size: 105 * 1024 * 1024, slice: (start: number, end: number) => ({ size: end - start }) };
    await context.uploadChunks(file, 3600, () => {});
    const chunks = calls.filter(c => c.method === "PUT");
    expect(chunks).toHaveLength(14);
    expect(chunks.every(c => c.body.size <= 8 * 1024 * 1024)).toBe(true);
    expect(chunks.reduce((sum, c) => sum + c.body.size, 0)).toBe(file.size);
    expect(calls.at(-1)?.url).toBe("/api/uploads/test/complete");
  });
  it("retries the same chunk offset after a network failure", async () => {
    const { context, calls } = client(true);
    await context.uploadChunks({ name: "video.mp4", size: 3, slice: () => ({ size: 3 }) }, 3600, () => {});
    const chunks = calls.filter(c => c.method === "PUT");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.url).toBe(chunks[1]!.url);
  });
});
