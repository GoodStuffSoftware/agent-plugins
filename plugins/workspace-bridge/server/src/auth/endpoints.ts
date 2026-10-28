// The three MCP endpoints, their scopes and names. Pure data (ARCHITECTURE s.2).

export const KINDS = ["full", "ro", "admin"] as const;
export type Kind = (typeof KINDS)[number];

export const PATH: Readonly<Record<Kind, string>> = {
  full: "/mcp",
  ro: "/mcp/ro",
  admin: "/mcp/admin",
};

/** Component scopes the owner grants on the consent page (plan s.4.2). */
export const COMPONENT_SCOPES = [
  "mail.read",
  "mail.write",
  "mail.send",
  "calendar",
  "files",
  "contacts",
] as const;
export type Scope = (typeof COMPONENT_SCOPES)[number] | "admin";

/**
 * Scopes a token may carry on each endpoint. `/mcp/ro` keeps `mail.write` for draft create and
 * update but never `mail.send`; `admin` exists only on `/mcp/admin`.
 */
export const SCOPES: Readonly<Record<Kind, readonly Scope[]>> = {
  full: COMPONENT_SCOPES,
  ro: ["mail.read", "mail.write", "calendar", "files", "contacts"],
  admin: ["admin"],
};

/** Every scope the authorization server advertises (`scopes_supported`). */
export const ALL_SCOPES: readonly Scope[] = [...new Set(KINDS.flatMap((k) => SCOPES[k]))];

/** `serverInfo.name` and `resource_name` per endpoint, distinct for claude.ai (plan s.4.1). */
export const SERVER_NAME: Readonly<Record<Kind, string>> = {
  full: "workspace-bridge",
  ro: "workspace-bridge-readonly",
  admin: "workspace-bridge-admin",
};

/** Canonical resource URL (RFC 8707 audience) of an endpoint under `issuer`. */
export function resourceUrl(kind: Kind, issuer: string): string {
  return issuer + PATH[kind];
}

/** The granted scopes that belong to an endpoint, in the endpoint's order. */
export function endpointScopes(kind: Kind, granted: readonly string[]): Scope[] {
  return SCOPES[kind].filter((s) => granted.includes(s));
}
