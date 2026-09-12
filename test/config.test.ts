import { afterEach, describe, expect, it } from "vitest";

import { assertRuntimeConfig, config, API_KEY_CLIENT } from "../src/config.js";
import { restoreConfig } from "./helpers.js";

const ORIGINAL_SECRET = config.secretKey;

afterEach(() => {
  config.secretKey = ORIGINAL_SECRET;
  restoreConfig();
});

/**
 * main.ts refuses to boot without SECRET_KEY (an empty key signs every session
 * with a publicly known constant). The guard needs its own test: nothing else
 * imports main.ts.
 */
describe("assertRuntimeConfig", () => {
  it("throws for a missing or blank SECRET_KEY", () => {
    config.secretKey = "";
    expect(() => assertRuntimeConfig()).toThrow(/SECRET_KEY is not set/);
    config.secretKey = "   ";
    expect(() => assertRuntimeConfig()).toThrow(/SECRET_KEY is not set/);
  });

  it("accepts a configured secret", () => {
    config.secretKey = "a-real-secret";
    expect(() => assertRuntimeConfig()).not.toThrow();
  });

  it("exposes the API-key client slug used by the auth hook", () => {
    expect(API_KEY_CLIENT).toBe("api-key-client");
  });
});
