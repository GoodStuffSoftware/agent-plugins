import { describe, expect, it } from "vitest";
import app from "../src/index";
import { VERSION } from "../src/version";

describe("GET /health", () => {
  it("reports ok, name and version", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "workspace-bridge", version: VERSION });
  });

  it("uses a semver version constant", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
