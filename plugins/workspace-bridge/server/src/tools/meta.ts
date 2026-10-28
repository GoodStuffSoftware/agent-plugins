// The meta family: `whoami` on every endpoint (ARCHITECTURE s.2).

import { z } from "zod";
import { KINDS } from "../auth/endpoints";
import { defineTool, type Family } from "../registry/types";
import { VERSION } from "../version";

const whoami = defineTool({
  name: "whoami",
  title: "Who am I",
  description:
    "Returns the owner id, the endpoint, the scopes this grant holds on it, the OAuth client id and the server version.",
  component: null,
  scopes: [],
  endpoints: KINDS,
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({}),
  async handler(_args, ctx) {
    return {
      ownerId: ctx.ownerId,
      kind: ctx.kind,
      scopes: ctx.grant.scopes,
      clientId: ctx.grant.clientId,
      version: VERSION,
    };
  },
});

export const meta: Family = {
  id: "meta",
  tools: [whoami],
  bindings: {},
  parityPending: [],
};
