import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SERVICE_VERSION } from "../src/version.js";

/**
 * /mcp advertises `serverInfo.version` from src/version.ts. This test keeps that
 * constant honest: bumping package.json without touching it would silently ship
 * an MCP server that lies about its version.
 */
describe("service version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    expect(SERVICE_VERSION).toBe(pkg.version);
  });
});
