// The signature helpers: embedded images are taken out, web images stay, the text part keeps "-- "
// and the HTML part gets the gmail_signature div. Pure; no D1, no network.

import { describe, expect, it } from "vitest";
import { dropEmbeddedImages } from "../src/core/html-text";
import { appendSignature, cleanSignature, signatureFor } from "../src/core/signature";

describe("dropEmbeddedImages", () => {
  const web = '<img src="https://example.com/logo.png" alt="Logo">';

  it("keeps a web image and takes out data: and cid: images, leaving the alt text", () => {
    expect(dropEmbeddedImages(web)).toBe(web);
    expect(dropEmbeddedImages('<img src="data:image/png;base64,AAAA" alt="Acme">')).toBe("Acme");
    expect(dropEmbeddedImages("<img src='cid:ii_1' alt='A & B'>x")).toBe("A &amp; Bx");
    expect(dropEmbeddedImages('<IMG SRC="DATA:image/png;base64,AAAA">')).toBe("");
  });

  it("still drops an image whose alt holds a > or whose tag starts with a slash", () => {
    expect(dropEmbeddedImages('<img alt="a>b" src="data:image/png;base64,AAAA">z')).toBe("a&gt;bz");
    expect(dropEmbeddedImages('<img/src="data:image/png;base64,AAAA">')).toBe("");
  });

  it("sees through an entity-encoded colon, a split scheme and srcset", () => {
    expect(dropEmbeddedImages('<img src="data&colon;image/png;base64,AAAA">')).toBe("");
    expect(dropEmbeddedImages('<img src="da&#116;a:image/png;base64,AAAA">x')).toBe("x");
    expect(dropEmbeddedImages('<img src="da\nta:image/png;base64,AAAA">')).toBe("");
    expect(dropEmbeddedImages('<img srcset="data:image/png;base64,AAAA 1x">')).toBe("");
    expect(
      dropEmbeddedImages(`<picture><source srcset="data:image/png;base64,AAAA">${web}</picture>`),
    ).toBe(`<picture>${web}</picture>`);
  });

  it("cuts an unterminated image tag off (a browser would not show it) and keeps a plain page", () => {
    expect(dropEmbeddedImages('<p>a</p><img src="data:image/png;base64,AAAA"')).toBe("<p>a</p>");
    expect(dropEmbeddedImages("<p>no images</p>")).toBe("<p>no images</p>");
  });

  it("is linear on a long run of broken tags", () => {
    const start = Date.now();
    dropEmbeddedImages("<img ".repeat(50_000));
    dropEmbeddedImages(`<img alt="${"<".repeat(50_000)}`);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("cleanSignature and appendSignature", () => {
  it("returns an empty string for a signature with no text and no image", () => {
    expect(cleanSignature(" <div><br></div> ")).toBe("");
    expect(cleanSignature("<b>Pat</b>")).toBe("<b>Pat</b>");
  });

  it("puts the dash line only in the text part and wraps the HTML part in gmail_signature", () => {
    const out = appendSignature({ text: "Hi", html: "<p>Hi</p>" }, "<b>Pat</b>");
    expect(out.text).toBe("Hi\n\n-- \nPat");
    expect(out.html).toContain('<div class="gmail_signature"><b>Pat</b></div>');
    expect(out.html).not.toContain("-- ");
  });
});

describe("signatureFor", () => {
  it("uses the alias signature, else the primary's, and reads the primary once", async () => {
    const asked: string[] = [];
    const fetch = async (email: string) => {
      asked.push(email);
      return email === "main@example.com" ? "<b>Main</b>" : "";
    };
    expect(await signatureFor(fetch, "alias@example.com", "main@example.com")).toBe("<b>Main</b>");
    expect(asked).toEqual(["alias@example.com", "main@example.com"]);
    asked.length = 0;
    expect(await signatureFor(fetch, "main@example.com", "main@example.com")).toBe("<b>Main</b>");
    expect(asked).toEqual(["main@example.com"]);
  });
});
