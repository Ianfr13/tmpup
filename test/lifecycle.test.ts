/**
 * src/lifecycle.ts holds the boot migration and the periodic cleanup that only
 * run in the real process (main.ts), so they need their own coverage.
 */
import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { migrateAllToInfiniteTtl, startCleanupLoop } from "../src/lifecycle.js";
import { FileMetadata, getFilePaths } from "../src/storage.js";
import { makeDataDir, removeDataDir, restoreConfig } from "./helpers.js";

let dataDir = "";

async function writeSidecar(ttl: number, createdAt: number): Promise<{ fileId: string; filePath: string }> {
  const fileId = randomUUID();
  const { filePath, metadataPath } = getFilePaths(fileId);
  await writeFile(filePath, "content");
  await new FileMetadata(fileId, "f.txt", ttl, createdAt, 0, 0, null, null, 7).save(metadataPath);
  return { fileId, filePath };
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  dataDir = await makeDataDir();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  restoreConfig();
  await removeDataDir(dataDir);
  dataDir = "";
});

describe("boot migration", () => {
  it("sets every stored file to never expire and counts the changes", async () => {
    const finite = await writeSidecar(3600, Date.now() / 1000);
    const infinite = await writeSidecar(0, Date.now() / 1000);

    const migrated = await migrateAllToInfiniteTtl();
    expect(migrated).toBe(1);

    expect((await FileMetadata.fromFile(path.join(dataDir, finite.fileId + ".meta.json")))?.ttl).toBe(0);
    expect((await FileMetadata.fromFile(path.join(dataDir, infinite.fileId + ".meta.json")))?.ttl).toBe(0);

    // Idempotent: a second boot has nothing to rewrite.
    expect(await migrateAllToInfiniteTtl()).toBe(0);
  });
});

describe("cleanup loop", () => {
  it("removes expired files while running and stops when told to", async () => {
    config.cleanupIntervalMs = 20;

    const expired = await writeSidecar(1, Date.now() / 1000 - 100);
    const stop = startCleanupLoop();
    await vi.waitFor(() => expect(exists(expired.filePath)).resolves.toBe(false), { timeout: 2000 });
    stop();

    const afterStop = await writeSidecar(1, Date.now() / 1000 - 100);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await exists(afterStop.filePath)).toBe(true);
  });
});
