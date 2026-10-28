// Registers an endpoint's tools on a per-request server (ARCHITECTURE s.1.4, s.3.1).
// Wrapper order: per-grant rate check, approval gate, handler, error mapping. An error that is not
// a `ToolError` is logged as one redacted line (s.3.3) before it becomes `internal`.

import type { McpServer } from "@modelcontextprotocol/server";
import { internalErrorLine, okResult, ToolError, toToolResult } from "../core/errors";
import type { Registry } from "./compile";
import { checkRate, gateApproval, type RequestScope, toolContext } from "./context";

export function registerAll(server: McpServer, registry: Registry, scope: RequestScope): void {
  for (const { def, schema, listed, challenge } of registry.byKind[scope.kind]) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: listed.description,
        inputSchema: schema,
        annotations: def.annotations,
        scopeChallenge: challenge,
      },
      async (args) => {
        try {
          const ctx = toolContext(scope, registry.providers);
          await checkRate(def, ctx);
          const pending = await gateApproval(def, args, ctx);
          if (pending !== undefined) return okResult(pending);
          return okResult(await def.handler(args as never, ctx));
        } catch (e) {
          if (!(e instanceof ToolError)) console.error(internalErrorLine(def.name, e, args));
          return toToolResult(e);
        }
      },
    );
  }
  // Only after the registerTool calls have installed the SDK's handlers (s.1.4). Also covers an
  // endpoint with no tools: the capability is declared, so the handler must exist.
  const tools = registry.listFor(scope.kind, scope.grant.scopes);
  server.server.setRequestHandler("tools/list", () => ({ tools: [...tools] }));
}
