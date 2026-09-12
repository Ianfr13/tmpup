/** Copy the server-rendered HTML templates into dist/ (portable: no POSIX cp). */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(root, "src", "templates");
const targetDir = path.join(root, "dist", "templates");

await mkdir(targetDir, { recursive: true });
let copied = 0;
for (const entry of await readdir(sourceDir)) {
  if (entry.endsWith(".html")) {
    await copyFile(path.join(sourceDir, entry), path.join(targetDir, entry));
    copied += 1;
  }
}
if (copied === 0) {
  throw new Error("no .html templates found in " + sourceDir);
}
console.log(`copied ${copied} template(s) to dist/templates`);
