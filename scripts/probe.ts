import Fastify from "fastify";
const app = Fastify({ bodyLimit: 1024 * 1024 });
app.addContentTypeParser("*", (_r, payload, done) => done(null, payload));
app.register(async (inst) => {
  inst.addContentTypeParser("*", (_r, payload, done) => done(null, payload));
  inst.post("/upload", async (req) => {
    const b: any = req.body;
    return { isStream: typeof b?.pipe === "function", type: typeof b, isBuffer: Buffer.isBuffer(b) };
  });
});
app.post("/json", async (req) => ({ body: req.body, type: typeof req.body }));
app.patch("/json", async (req) => ({ body: req.body, type: typeof req.body }));
await app.ready();
for (const ct of ["text/plain", "application/json", "application/octet-stream"]) {
  const r = await app.inject({ method: "POST", url: "/upload", headers: { "content-type": ct }, payload: ct === "application/json" ? JSON.stringify({ a: 1 }) : "hello-bytes" });
  console.log("upload", ct, r.statusCode, r.body);
}
const j = await app.inject({ method: "POST", url: "/json", headers: { "content-type": "application/json" }, payload: { a: 1 } });
console.log("root json POST", j.statusCode, j.body);
const big = await app.inject({ method: "POST", url: "/upload", headers: { "content-type": "application/octet-stream" }, payload: Buffer.alloc(3 * 1024 * 1024, 7) });
console.log("3MB upload with 1MB bodyLimit", big.statusCode, big.body.slice(0, 120));