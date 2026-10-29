// The account's Gmail signature on an outgoing message (`sendAs.signature`, HTML).
//
// The signature is the owner's own content, but it only ever travels inside the base64 text parts
// of the message (core/mime.ts `textPart`), so nothing in it can add a header or end a MIME part.
// Pictures it carries inside itself (`data:` or `cid:`) are taken out before sending: Gmail would
// turn each into an inline attachment with a made-up name, which Yahoo and others show as a
// broken attachment. A picture with a web address stays and renders from there.

import { dropEmbeddedImages, htmlToText } from "./html-text";
import { escapeHtml } from "./mime";

/** What the signature fetcher gets: a send-as address; it answers the signature HTML, or "". */
export type SignatureFetch = (email: string) => Promise<string>;

/** The signature without embedded pictures; "" when nothing visible is left. */
export function cleanSignature(html: string): string {
  const cleaned = dropEmbeddedImages(html).trim();
  const visible = htmlToText(cleaned).trim() !== "" || /<img\b/i.test(cleaned);
  return visible ? cleaned : "";
}

/**
 * The signature to use for a message sent as `from`: its own, else the account's primary one when
 * the alias has none. "" when neither has any content.
 */
export async function signatureFor(
  fetch: SignatureFetch,
  from: string,
  primary: string,
): Promise<string> {
  const own = cleanSignature(await fetch(from));
  if (own !== "" || from === primary) return own;
  return cleanSignature(await fetch(primary));
}

/**
 * The message text and HTML with the signature added: after a `-- ` line in the text; in the
 * HTML in a `gmail_signature` div, as Gmail does, with no dash line.
 */
export function appendSignature(
  parts: { text: string; html: string | undefined },
  signature: string,
): { text: string; html: string } {
  const html = parts.html ?? escapeHtml(parts.text).replace(/\n/g, "<br>\n");
  const plain = htmlToText(signature).trim();
  return {
    text: plain === "" ? parts.text : `${parts.text}\n\n-- \n${plain}`,
    html: `${html}<br>\n<div class="gmail_signature">${signature}</div>`,
  };
}
