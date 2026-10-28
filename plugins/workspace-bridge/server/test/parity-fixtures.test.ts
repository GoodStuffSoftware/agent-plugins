import { describe, expect, it } from "vitest";
import calendar from "./fixtures/parity/calendar.json";
import drive from "./fixtures/parity/drive.json";
import gmail from "./fixtures/parity/gmail.json";

// Captured tool lists of the official connectors. The real parity check (our tools/list
// against these) arrives once a tool registry exists.
describe("parity fixtures", () => {
  it.each([
    ["gmail", gmail, 30],
    ["calendar", calendar, 9],
    ["drive", drive, 11],
  ] as const)("%s holds %i tools", (_name, tools, count) => {
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(count);
    for (const tool of tools as { name?: unknown }[]) {
      expect(typeof tool.name).toBe("string");
    }
  });
});
