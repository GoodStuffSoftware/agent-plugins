// Google API scopes per account component and token revocation (ARCHITECTURE s.2, s.4; plan s.9
// "Scopes per component"). The OAuth authorize and token endpoints live in `auth/google-oidc.ts`.

/**
 * The parts of a linked mailbox the owner can switch on (plan s.4.3). `mail` is read and write
 * (labels, state, drafts, filters); `mail.send` is sending. Stored in `accounts.components`.
 */
export const ACCOUNT_COMPONENTS = ["mail", "mail.send", "calendar", "files", "contacts"] as const;
export type AccountComponent = (typeof ACCOUNT_COMPONENTS)[number];

export const isAccountComponent = (value: unknown): value is AccountComponent =>
  typeof value === "string" && (ACCOUNT_COMPONENTS as readonly string[]).includes(value);

const API = "https://www.googleapis.com/auth/";

export const GOOGLE_SCOPES = {
  /** Read, organize, draft and send. Covers `gmail.send` and `gmail.labels`. */
  gmailModify: `${API}gmail.modify`,
  /** Send only, for a send-only account. */
  gmailSend: `${API}gmail.send`,
  /** Filters and the sendAs list. */
  gmailSettingsBasic: `${API}gmail.settings.basic`,
  /** Full calendar access, for parity with the official calendar tools. */
  calendar: `${API}calendar`,
  /** Full Drive access (plan D3). */
  drive: `${API}drive`,
  contacts: `${API}contacts.readonly`,
  otherContacts: `${API}contacts.other.readonly`,
} as const;

/** Identity scopes every link requests besides `scopesFor`: the callback checks the address. */
export const LINK_IDENTITY_SCOPES: readonly string[] = ["openid", "email"];

export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/**
 * The Google API scopes for a set of components, in component order without duplicates. Mail
 * read and write asks for `gmail.modify` and `gmail.settings.basic`; sending is covered by
 * `gmail.modify`, so `gmail.send` is asked for only when send is on and read and write is off.
 */
export function scopesFor(components: readonly AccountComponent[]): string[] {
  const on = new Set(components);
  const out: string[] = [];
  if (on.has("mail")) out.push(GOOGLE_SCOPES.gmailModify, GOOGLE_SCOPES.gmailSettingsBasic);
  if (on.has("mail.send") && !on.has("mail")) out.push(GOOGLE_SCOPES.gmailSend);
  if (on.has("calendar")) out.push(GOOGLE_SCOPES.calendar);
  if (on.has("files")) out.push(GOOGLE_SCOPES.drive);
  if (on.has("contacts")) out.push(GOOGLE_SCOPES.contacts, GOOGLE_SCOPES.otherContacts);
  return out;
}

/**
 * The components, in `ACCOUNT_COMPONENTS` order, whose scopes are all in `granted`. Google may
 * grant fewer scopes than asked; a component missing one stays off. `gmail.modify` stands in for
 * `gmail.send`.
 */
export function grantedComponents(
  components: readonly AccountComponent[],
  granted: readonly string[],
): AccountComponent[] {
  const has = new Set(granted);
  if (has.has(GOOGLE_SCOPES.gmailModify)) has.add(GOOGLE_SCOPES.gmailSend);
  return ACCOUNT_COMPONENTS.filter(
    (c) => components.includes(c) && scopesFor([c]).every((s) => has.has(s)),
  );
}

/**
 * The API scopes in `granted` that `components` do not need: what "re-link minimal" would drop.
 * The identity scopes of a link are not counted.
 */
export function excessScopes(
  components: readonly AccountComponent[],
  granted: readonly string[],
): string[] {
  const keep = new Set<string>([
    ...scopesFor(components),
    ...LINK_IDENTITY_SCOPES,
    `${API}userinfo.email`,
    `${API}userinfo.profile`,
  ]);
  return granted.filter((s) => !keep.has(s));
}

/** Splits Google's space-separated `scope` answer into unique scopes, in its order. */
export function parseScopes(scope: string | undefined): string[] {
  return [...new Set((scope ?? "").split(/\s+/).filter((s) => s !== ""))];
}

/**
 * Revokes a Google token. A refresh token revokes the whole grant, access tokens included.
 * Resolves true when Google confirms it, or answers 400 (the token is already invalid); false on
 * any other answer or a network failure. The token is never logged.
 */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    await res.body?.cancel();
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}
