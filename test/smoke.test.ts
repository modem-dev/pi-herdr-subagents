import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("package", () => {
  it("extension entry module loads and exports a default function", async () => {
    const mod = await import("../index.ts");
    assert.equal(typeof mod.default, "function");
  });
});
