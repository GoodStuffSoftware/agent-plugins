// A browser with a cookie jar that drives owner sign-in and consent through the Worker
// (ARCHITECTURE s.6), and MCP clients to start authorizations with. Only `fetch` to Google is
// faked (helpers/google.ts); the OAuth library runs for real.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { type Kind, resourceUrl, SCOPES } from "../../src/auth/endpoints";
import { getAuth } from "../../src/auth/server";
import { base64url, randomBytes, sha256 } from "../../src/core/crypto";
import { config } from "../../src/env";
import worker from "../../src/index";
import type { FakeGoogle, GoogleUser } from "./google";
import { exchangeCode, REDIRECT_URI } from "./tokens";

export const ISSUER = "https://mcp.example.com";

export interface McpClient {
  clientId: string;
  kind: Kind;
  resource: string;
  verifier: string;
  /** `GET /authorize?...` for this client: PKCE S256, `resource`, its endpoint's scopes. */
  authorizeUrl: string;
}

/** Registers an MCP client and builds its authorization request. */
export async function mcpClient(
  kind: Kind,
  {
    confidential = false,
    pkce = true,
    clientName = "Example Client",
  }: { confidential?: boolean; pkce?: boolean; clientName?: string } = {},
): Promise<McpClient> {
  const api = getAuth(env).as.getOAuthApi(env);
  const client = await api.createClient({
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethod: confidential ? "client_secret_basic" : "none",
    clientName,
  });
  const verifier = base64url(randomBytes(32));
  const resource = resourceUrl(kind, config(env).issuer);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES[kind].join(" "),
    state: `client-state-${kind}`,
    resource,
  });
  if (pkce) {
    params.set("code_challenge", base64url(await sha256(verifier)));
    params.set("code_challenge_method", "S256");
  }
  return {
    clientId: client.clientId,
    kind,
    resource,
    verifier,
    authorizeUrl: `${ISSUER}/authorize?${params}`,
  };
}

export interface ConsentForm {
  page: Response;
  html: string;
  handle: string;
  csrf: string;
  /** The scope checkboxes offered, in page order. */
  offered: string[];
  /** The checkboxes that are checked by default. */
  checked: string[];
}

export class Browser {
  private readonly jar = new Map<string, string>();
  /** The `env` the Worker sees; replace it to change configuration mid-test. */
  env: Cloudflare.Env;

  constructor(overrides: Partial<Cloudflare.Env> = {}) {
    this.env = { ...env, ...overrides };
  }

  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  setCookie(name: string, value: string): void {
    this.jar.set(name, value);
  }

  async fetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size > 0) {
      headers.set("Cookie", [...this.jar].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(url, { ...init, headers }), this.env, ctx);
    await waitOnExecutionContext(ctx);
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /;\s*Max-Age=0\b/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }

  /** `GET /authorize` without a session: expects the redirect to Google and returns its URL. */
  async startSignin(client: McpClient): Promise<URL> {
    const res = await this.fetch(client.authorizeUrl);
    expect(res.status).toBe(302);
    return new URL(res.headers.get("Location") ?? "");
  }

  /** Signs in at the fake Google as `user` and returns the callback's response. */
  async signin(google: FakeGoogle, client: McpClient, user: GoogleUser): Promise<Response> {
    const googleUrl = await this.startSignin(client);
    return this.fetch(google.approve(googleUrl, user));
  }

  /** `GET /authorize` with a session: expects the consent page and reads its form. */
  async consent(client: McpClient): Promise<ConsentForm> {
    const page = await this.fetch(client.authorizeUrl);
    expect(page.status).toBe(200);
    const html = await page.text();
    const field = (name: string) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];
    const boxes = [...html.matchAll(/name="scope" value="([^"]+)"( checked)?/g)];
    return {
      page,
      html,
      handle: field("handle") ?? "",
      csrf: field("csrf") ?? "",
      offered: boxes.map((m) => m[1] ?? ""),
      checked: boxes.filter((m) => m[2]).map((m) => m[1] ?? ""),
    };
  }

  /** Sign-in, then the consent page. */
  async signinAndConsent(
    google: FakeGoogle,
    client: McpClient,
    user: GoogleUser,
  ): Promise<ConsentForm> {
    const callback = await this.signin(google, client, user);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe(client.authorizeUrl);
    return this.consent(client);
  }

  /** Posts the consent form. `csrf: null` leaves the token out. */
  submit(
    form: ConsentForm,
    {
      decision = "approve",
      scopes = form.checked,
      csrf = form.csrf,
    }: { decision?: string; scopes?: readonly string[]; csrf?: string | null } = {},
  ): Promise<Response> {
    const body = new URLSearchParams({ handle: form.handle, decision });
    if (csrf !== null) body.set("csrf", csrf);
    for (const scope of scopes) body.append("scope", scope);
    return this.fetch(`${ISSUER}/authorize`, { method: "POST", body });
  }
}

/** Exchanges the code in an approval redirect for tokens at `/oauth/token`. */
export async function redeem(
  client: McpClient,
  approval: Response,
): Promise<{ access_token: string; scope: string }> {
  expect(approval.status).toBe(302);
  const location = new URL(approval.headers.get("Location") ?? "");
  expect(location.origin + location.pathname).toBe(REDIRECT_URI);
  const code = location.searchParams.get("code");
  expect(code).toBeTruthy();
  const res = await exchangeCode({
    code: code ?? "",
    verifier: client.verifier,
    clientId: client.clientId,
    resource: client.resource,
  });
  expect(res.status).toBe(200);
  return res.json();
}
