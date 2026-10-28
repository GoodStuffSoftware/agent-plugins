// Parity ratchet (ARCHITECTURE s.5): every official tool is either built, with the official
// required params, or listed in its family's `parityPending`. Pending lists only shrink.

import { describe, expect, it } from "vitest";
import { ALL_SCOPES, KINDS } from "../src/auth/endpoints";
import { REGISTRY } from "../src/registry/compile";
import { FAMILIES } from "../src/tools";
import calendar from "./fixtures/parity/calendar.json";
import drive from "./fixtures/parity/drive.json";
import gmail from "./fixtures/parity/gmail.json";

interface Official {
  name: string;
  inputSchema: { required?: string[] };
}

interface Schema {
  properties?: Record<string, unknown>;
  required?: string[];
}

/** Extra required params beyond the official set, one entry per tool with a reason. */
const PARAM_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {};

const official = [...gmail, ...calendar, ...drive] as Official[];

const implemented = new Map<string, Schema>(
  KINDS.flatMap((k) =>
    REGISTRY.listFor(k, ALL_SCOPES).map((t) => [t.name, t.inputSchema as Schema] as const),
  ),
);
const pending = new Set(FAMILIES.flatMap((f) => f.parityPending));

describe("parity ratchet", () => {
  it("covers the 50 official tools", () => {
    expect(official).toHaveLength(50);
    expect(new Set(official.map((o) => o.name)).size).toBe(50);
  });

  it("lists only official names as pending", () => {
    const names = new Set(official.map((o) => o.name));
    for (const p of pending) expect(names.has(p), `${p} is not an official tool`).toBe(true);
    const all = FAMILIES.flatMap((f) => f.parityPending);
    expect(all).toHaveLength(pending.size);
  });

  it.each(official.map((o) => [o.name, o] as const))("%s", (name, o) => {
    const ours = implemented.get(name);
    if (pending.has(name)) {
      expect(ours, `${name} is built: remove it from parityPending`).toBeUndefined();
      return;
    }
    expect(ours, `${name} is neither built nor pending`).toBeDefined();
    const req = o.inputSchema.required ?? [];
    for (const p of req) expect(ours?.properties ?? {}).toHaveProperty(p);
    expect(ours?.required ?? []).toEqual(expect.arrayContaining(req));
    const extra = (ours?.required ?? []).filter((p) => !req.includes(p));
    expect(extra).toEqual(PARAM_EXCEPTIONS[name] ?? []);
  });
});
