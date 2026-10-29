// M13: the RFC 822 builder and its helpers (src/core/mime.ts). Pure functions, no Worker.

import { describe, expect, it } from "vitest";
import { ToolError } from "../src/core/errors";
import {
  b64urlToBytes,
  binaryToBytes,
  buildRfc822,
  bytesToB64,
  canonicalAddress,
  decodeEncodedWords,
  encodeAddress,
  encodeHeader,
  extractBody,
  extractHtmlBody,
  forwardSubject,
  htmlToText,
  normalizeMessageId,
  parseAddresses,
  readAddressList,
  replyRecipients,
  replySubject,
  sanitizeReferences,
  splitAddressList,
} from "../src/core/mime";

/** The value of a header, unfolded. */
const header = (raw: string, name: string): string | undefined =>
  raw
    .split("\r\n\r\n")[0]
    ?.match(new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, "im"))?.[1]
    ?.replace(/\r\n[ \t]/g, " ");

/** The decoded text of every base64 body part, in order. */
function bodies(raw: string): string[] {
  return [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)].map(
    (m) => {
      const bin = atob((m[1] ?? "").replace(/\s+/g, ""));
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    },
  );
}

const b64u = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function refused(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    return e as ToolError;
  }
  throw new Error("expected a ToolError");
}

describe("buildRfc822 bodies", () => {
  it("builds a plain text message", () => {
    const raw = buildRfc822({
      to: ["Bob <bob@example.com>"],
      cc: ["cy@example.com"],
      subject: "Status",
      body: "All good\nsecond line",
    });
    expect(header(raw, "To")).toBe("Bob <bob@example.com>");
    expect(header(raw, "Cc")).toBe("cy@example.com");
    expect(header(raw, "Subject")).toBe("Status");
    expect(header(raw, "MIME-Version")).toBe("1.0");
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).not.toContain("multipart");
    expect(bodies(raw)).toEqual(["All good\r\nsecond line"]);
    // No Bcc or From header unless asked for.
    expect(header(raw, "Bcc")).toBeUndefined();
    expect(header(raw, "From")).toBeUndefined();
  });

  it("builds multipart/alternative with the text part first", () => {
    const raw = buildRfc822({
      to: ["bob@example.com"],
      subject: "Both",
      body: "plain",
      htmlBody: "<p>rich</p>",
    });
    const type = raw.match(/Content-Type: multipart\/alternative; boundary="([^"]+)"/);
    expect(type).not.toBeNull();
    expect(type?.[1]).toMatch(/^=_wb_/);
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("text/html"));
    expect(bodies(raw)).toEqual(["plain", "<p>rich</p>"]);
    expect(raw.trimEnd().endsWith(`--${type?.[1]}--`)).toBe(true);
  });

  it("wraps encoded body lines at 76 columns", () => {
    const raw = buildRfc822({ to: ["a@example.com"], subject: "Long", body: "x".repeat(500) });
    const part = raw.split("Content-Transfer-Encoding: base64\r\n\r\n")[1] ?? "";
    const lines = part.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
    expect(bodies(raw)[0]).toBe("x".repeat(500));
  });

  it("writes CRLF line ends whatever the input uses", () => {
    const raw = buildRfc822({ to: ["a@example.com"], subject: "s", body: "a\nb\rc\r\nd" });
    expect(bodies(raw)).toEqual(["a\r\nb\r\nc\r\nd"]);
  });

  it("allows a draft with no recipient and refuses a message with none on request", () => {
    expect(() => buildRfc822({ subject: "s", body: "b" })).not.toThrow();
    const e = refused(() => buildRfc822({ subject: "s", body: "b" }, { requireRecipient: true }));
    expect(e.code).toBe("invalid_argument");
  });

  it("sets the threading headers", () => {
    const raw = buildRfc822({
      to: ["a@example.com"],
      subject: "Re: x",
      body: "b",
      inReplyTo: "<orig@example.net>",
      references: "<root@example.net> <orig@example.net>",
    });
    expect(header(raw, "In-Reply-To")).toBe("<orig@example.net>");
    expect(header(raw, "References")).toBe("<root@example.net> <orig@example.net>");
  });
});

describe("RFC 2047", () => {
  it("encodes a non-ASCII subject and keeps the header ASCII", () => {
    const subject = "Café Ünïcode ✓ \u{1F600}";
    const raw = buildRfc822({ to: ["a@example.com"], subject, body: "b" });
    const head = raw.split("\r\n\r\n")[0] ?? "";
    expect(head).toMatch(/^[\x20-\x7e\r\n]*$/);
    expect(header(raw, "Subject")).toContain("=?UTF-8?B?");
    expect(decodeEncodedWords(header(raw, "Subject") ?? "")).toBe(subject);
  });

  it("keeps every encoded word within 75 octets and splits only between characters", () => {
    const subject = "é".repeat(120);
    const encoded = encodeHeader(subject);
    const words = encoded.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    expect(decodeEncodedWords(encoded.replace(/\r\n /g, " "))).toBe(subject);
  });

  it("encodes a non-ASCII display name and leaves the address alone", () => {
    const raw = buildRfc822({
      to: ["Zoë Müller <zoe@example.com>", "Plain Name <plain@example.com>"],
      subject: "s",
      body: "b",
    });
    const to = header(raw, "To") ?? "";
    expect(to).toMatch(/=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <zoe@example\.com>/);
    expect(to).toContain("Plain Name <plain@example.com>");
    expect(decodeEncodedWords(to)).toContain("Zoë Müller <zoe@example.com>");
  });

  it("quotes a display name with specials", () => {
    expect(encodeAddress("Doe, John <j@example.com>")).toBe('"Doe, John" <j@example.com>');
    expect(encodeAddress('"Doe, John" <j@example.com>')).toBe('"Doe, John" <j@example.com>');
    expect(encodeAddress("j@example.com")).toBe("j@example.com");
    expect(encodeAddress("Bob (work) <b@example.com>")).toBe('"Bob (work)" <b@example.com>');
  });

  it("does not encode a name twice when it is read back and rebuilt", () => {
    const first = buildRfc822({ to: ["Zoë <zoe@example.com>"], subject: "Café", body: "b" });
    const entries = readAddressList(header(first, "To"));
    expect(entries).toEqual(["Zoë <zoe@example.com>"]);
    const second = buildRfc822({
      to: entries,
      subject: decodeEncodedWords(header(first, "Subject") ?? ""),
      body: "b",
    });
    expect(header(second, "To")).toBe(header(first, "To"));
    expect(header(second, "Subject")).toBe(header(first, "Subject"));
  });
});

describe("header injection", () => {
  const base = { to: ["a@example.com"], subject: "s", body: "b" };
  const cases: [string, Parameters<typeof buildRfc822>[0]][] = [
    ["subject LF", { ...base, subject: "Hi\nBcc: evil@example.net" }],
    ["subject CRLF", { ...base, subject: "Hi\r\nBcc: evil@example.net" }],
    ["subject CR", { ...base, subject: "Hi\rBcc: evil@example.net" }],
    ["subject NUL", { ...base, subject: "Hi\0there" }],
    ["to", { ...base, to: ["a@example.com\r\nBcc: evil@example.net"] }],
    ["cc", { ...base, cc: ["a@example.com\nBcc: evil@example.net"] }],
    ["bcc", { ...base, bcc: ["a@example.com\rX: y"] }],
    ["display name", { ...base, to: ["Mallory\r\nBcc: e@example.net <m@example.com>"] }],
    ["from", { ...base, from: "me@example.com\r\nBcc: evil@example.net" }],
    ["in-reply-to", { ...base, inReplyTo: "<a@b>\r\nBcc: evil@example.net" }],
    ["references", { ...base, references: "<a@b>\nBcc: evil@example.net" }],
  ];
  it.each(cases)("refuses a line break in the %s", (_name, message) => {
    const e = refused(() => buildRfc822(message));
    expect(e.code).toBe("invalid_argument");
    // The message names the header and never echoes the value.
    expect(e.message).not.toContain("evil@example.net");
  });

  it("never lets a body line start a header", () => {
    const raw = buildRfc822({ ...base, body: "x\r\nBcc: evil@example.net" });
    expect(header(raw, "Bcc")).toBeUndefined();
  });
});

describe("address helpers", () => {
  it("splits a list on commas outside quotes, angles and comments", () => {
    expect(
      splitAddressList('"Doe, John" <j@example.com>, b@example.com, C (x, y) <c@example.com>'),
    ).toEqual(['"Doe, John" <j@example.com>', "b@example.com", "C (x, y) <c@example.com>"]);
  });

  it("parses bare lowercase addresses", () => {
    expect(parseAddresses('"Doe, John" <J@Example.com>, b@example.com, B@example.com')).toEqual([
      "j@example.com",
      "b@example.com",
    ]);
    expect(parseAddresses(undefined)).toEqual([]);
  });

  it("recognises the account itself through tags and gmail dots", () => {
    expect(canonicalAddress("Jo.Hn+news@gmail.com")).toBe("john@gmail.com");
    expect(canonicalAddress("a.b+x@work.example.com")).toBe("a.b@work.example.com");
  });

  it("replies to Reply-To else From, minus the account's own addresses", () => {
    expect(
      replyRecipients({
        self: ["me@example.com"],
        from: ["sam@example.net"],
        to: ["me+tag@example.com", "pat@example.net"],
        cc: ["lee@example.net"],
        replyTo: [],
      }),
    ).toEqual({ to: ["sam@example.net"], cc: ["pat@example.net", "lee@example.net"] });
    expect(
      replyRecipients({
        self: ["me@example.com"],
        from: ["sam@example.net"],
        to: [],
        cc: [],
        replyTo: ["list@example.net"],
      }).to,
    ).toEqual(["list@example.net"]);
    // Answering mail the account sent goes to the original recipients.
    expect(
      replyRecipients({
        self: ["me@example.com"],
        from: ["me@example.com"],
        to: ["pat@example.net"],
        cc: [],
        replyTo: [],
      }).to,
    ).toEqual(["pat@example.net"]);
  });

  it("prefixes subjects once and reads encoded ones", () => {
    expect(replySubject("Plan")).toBe("Re: Plan");
    expect(replySubject("RE: Plan")).toBe("RE: Plan");
    expect(replySubject("=?UTF-8?B?Q2Fmw6k=?=")).toBe("Re: Café");
    expect(replySubject("Plan\r\n")).toBe("Re: Plan");
    expect(forwardSubject("Plan")).toBe("Fwd: Plan");
    expect(forwardSubject("Fwd: Plan")).toBe("Fwd: Plan");
  });

  it("accepts only real message ids for threading", () => {
    expect(normalizeMessageId("<a@b.example>")).toBe("<a@b.example>");
    expect(normalizeMessageId("a@b.example")).toBe("<a@b.example>");
    expect(normalizeMessageId("18c3f2a9b1d4e5f6")).toBeNull();
    expect(normalizeMessageId("<a b@c>")).toBeNull();
    expect(sanitizeReferences("<r@x> junk <s@x>", "<o@x>")).toBe("<r@x> <s@x> <o@x>");
    expect(sanitizeReferences(undefined, null)).toBeUndefined();
  });
});

describe("reading a Gmail payload", () => {
  const part = (mimeType: string, text: string, extra: object = {}) => ({
    mimeType,
    body: { data: b64u(text) },
    ...extra,
  });

  it("takes the text part, and the HTML part as written", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [part("text/plain", "hello\r\nworld"), part("text/html", "<p>hi</p>")],
    };
    expect(extractBody(payload)).toBe("hello\nworld");
    expect(extractHtmlBody(payload)).toBe("<p>hi</p>");
  });

  it("falls back to the text of the HTML and skips attachments", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        part("text/html", "<div>Hi<br>there &amp; <b>you</b></div>"),
        part("text/plain", "ATTACHED", { filename: "note.txt" }),
      ],
    };
    expect(extractBody(payload)).toBe("Hi\nthere &  you");
    expect(htmlToText("<style>x{}</style><p>a</p><script>1</script>")).toBe("a");
  });
});

describe("base64 hot paths", () => {
  const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  // Larger than one 8192-byte chunk and not a multiple of 3, so the chunk seams and padding are hit.
  const big = Uint8Array.from({ length: 524_289 }, (_, i) => (i * 31 + 7) & 0xff);

  it("bytesToB64 matches Buffer on every byte value and on a body spanning many chunks", () => {
    for (const bytes of [new Uint8Array(0), allBytes, big]) {
      expect(bytesToB64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });

  it("b64urlToBytes round-trips url-safe base64", () => {
    for (const bytes of [allBytes, big, new Uint8Array([251, 255, 254])]) {
      const url = Buffer.from(bytes).toString("base64url");
      expect(Array.from(b64urlToBytes(url))).toEqual(Array.from(bytes));
    }
  });

  it("binaryToBytes maps each char code to one byte", () => {
    expect(Array.from(binaryToBytes("\u0000Aÿ"))).toEqual([0, 65, 255]);
    expect(binaryToBytes("")).toHaveLength(0);
  });
});
