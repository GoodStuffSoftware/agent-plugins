// Sanitizes the HTML of a held email for the owner's approval page, with the HTMLRewriter built into
// Workers (no dependency). An allow list: a tag not on it is dropped and its content kept, the
// dangerous ones are dropped with their content, and an attribute not on the list is removed.
// Nothing remote is ever kept: no `img src` that is not an inline image, no `srcset`, no CSS
// `url()` or `@import`, no `link`, `meta`, `base`, `iframe`, `object`, `embed` or `form`; links lose
// their `javascript:` and every other scheme but http, https, mailto and tel.
//
// This is one layer. The result is shown only in a sandboxed iframe (no scripts, no same origin)
// under a Content-Security-Policy that forbids every load, so a miss here is still contained
// (`previewDocument` in `preview-views.ts`).

/** Tags kept, with their content. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "address",
  "b",
  "big",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "tt",
  "u",
  "ul",
  "wbr",
]);

/** Tags removed together with everything inside them. */
const DROPPED_WITH_CONTENT: ReadonlySet<string> = new Set([
  "applet",
  "audio",
  "base",
  "button",
  "canvas",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "input",
  "link",
  "map",
  "math",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "option",
  "param",
  "script",
  "select",
  "source",
  "svg",
  "template",
  "textarea",
  "title",
  "track",
  "video",
  "xmp",
]);

/** Attributes kept on any allowed tag. */
const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  "align",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "class",
  "color",
  "colspan",
  "dir",
  "face",
  "height",
  "lang",
  "rowspan",
  "size",
  "style",
  "title",
  "valign",
  "width",
]);

const SAFE_LINK = /^(?:https?:|mailto:|tel:)/i;
/** The only `src` kept: an inline raster image. Anything else is a remote load. */
const INLINE_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
/** Whether a browser ignores this character inside a URL scheme (`java<TAB>script:`). */
const isUrlNoise = (c: number): boolean =>
  c <= 0x20 ||
  (c >= 0x7f && c <= 0x9f) ||
  (c >= 0x200b && c <= 0x200f) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0xfeff;

/** A link target when it is http, https, mailto or tel, else undefined. */
export function safeHref(value: string): string | undefined {
  const flat = [...value].filter((ch) => !isUrlNoise(ch.codePointAt(0) ?? 0)).join("");
  return SAFE_LINK.test(flat) ? value.trim() : undefined;
}

/**
 * CSS with every way to load something or run something taken out: `url()`, `@import`,
 * `image-set()`, `expression()`, `behavior`, `-moz-binding`, and backslash escapes (which can hide
 * any of those). Used for `<style>` text and for `style` attributes.
 */
export function sanitizeCss(css: string): string {
  return css
    .replace(/\\/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import\b[^;{}]*;?/gi, "")
    .replace(/(?:-webkit-)?(?:image-set|image|src|cross-fade|element|paint)\s*\([^)]*\)?/gi, "none")
    .replace(/url\s*\([^)]*\)?/gi, "none")
    .replace(/expression\s*\([^)]*\)?/gi, "none")
    .replace(/(?:behavior|-moz-binding)\s*:[^;}]*;?/gi, "");
}

/** A `style` attribute is kept, sanitized, unless sanitizing left an unquoted trace of a load. */
const safeStyle = (value: string): string => sanitizeCss(value);

const escText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What an image becomes: its alt text in brackets, so nothing is fetched. */
const imagePlaceholder = (alt: string | null): string =>
  `<span class="blocked-image">[image${alt ? `: ${escText(alt.slice(0, 120))}` : ""}]</span>`;

/**
 * The sanitized fragment of `markup`, safe to place in a document body (still to be shown only in
 * the sandboxed frame). Never throws on malformed markup.
 */
export async function sanitizeEmailHtml(markup: string): Promise<string> {
  // A <style> element cannot nest, so one buffer serves them all.
  let styleText = "";
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (DROPPED_WITH_CONTENT.has(tag)) {
          el.remove();
          return;
        }
        if (!ALLOWED_TAGS.has(tag)) {
          // form, html, body and any unknown tag: the text inside stays, the tag goes.
          el.removeAndKeepContent();
          return;
        }
        const attrs = [...el.attributes].map(([n, v]) => [n ?? "", v ?? ""] as const);
        if (tag === "img") {
          const alt = attrs.find(([n]) => n.toLowerCase() === "alt")?.[1] ?? null;
          const src = (attrs.find(([n]) => n.toLowerCase() === "src")?.[1] ?? "").trim();
          if (!INLINE_IMAGE.test(src)) {
            el.replace(imagePlaceholder(alt), { html: true });
            return;
          }
        }
        for (const [rawName, value] of attrs) {
          const name = rawName.toLowerCase();
          el.removeAttribute(rawName);
          if (name === "style") {
            const css = safeStyle(value);
            if (css.trim() !== "") el.setAttribute("style", css);
          } else if (tag === "a" && name === "href") {
            const href = safeHref(value);
            if (href !== undefined) {
              el.setAttribute("href", href);
              el.setAttribute("title", href);
            }
          } else if (tag === "img" && (name === "src" || name === "alt")) {
            if (name === "src") el.setAttribute("src", value.trim());
            else el.setAttribute("alt", value);
          } else if (ALLOWED_ATTRS.has(name) && !(tag === "a" && name === "title")) {
            el.setAttribute(name, value);
          }
        }
        if (tag === "a") {
          // Dead on purpose: the sandbox has no popups, so a click does nothing.
          el.setAttribute("rel", "noopener noreferrer");
          el.setAttribute("target", "_blank");
        }
      },
      comments(c) {
        c.remove();
      },
    })
    .on("style", {
      text(chunk) {
        // A pattern can span chunks, so the text is gathered and written once, at the end.
        styleText += chunk.text;
        chunk.remove();
        if (chunk.lastInTextNode) {
          chunk.after(sanitizeCss(styleText).replace(/<\/?style/gi, ""), { html: true });
          styleText = "";
        }
      },
    });
  const out = await rewriter.transform(new Response(markup)).text();
  // The rewriter keeps a doctype; a fragment has no use for it.
  return out.replace(/<!doctype[^>]*>/gi, "");
}
