// The owner pages' theme: CSS appended after the base sheet, an optional product name, and
// optional assets (SVG images, woff2 fonts) that the Worker serves itself at /theme/assets/<name>.
// `theme.generated.ts` is built from the `theme/` directory by scripts/build-theme.mjs; a deploy
// replaces that directory (docs/SELF-HOSTING.md, "Theming"). Nothing here names a brand.

import { THEME_DATA } from "./theme.generated";

export interface ThemeAsset {
  /** Content type: `image/svg+xml` or `font/woff2`. */
  type: string;
  /** SVG source. */
  text?: string;
  /** woff2 bytes, base64. */
  base64?: string;
}

export interface ThemeData {
  /** Appended to the base stylesheet; may be empty. */
  css: string;
  /** Product name in the header; empty means the default "workspace-bridge". */
  name: string;
  assets: Record<string, ThemeAsset>;
}

/** Where assets are served from, and what theme CSS and the header use to name them. */
export const ASSET_BASE = "/theme/assets/";

let active: ThemeData = THEME_DATA;
let assetBase = ASSET_BASE;

export const getTheme = (): ThemeData => active;

/** Replaces the theme (tests, the snapshot script) and where its assets live; no argument resets. */
export function setTheme(theme?: ThemeData, base: string = ASSET_BASE): void {
  active = theme ?? THEME_DATA;
  assetBase = base;
}

/** The theme CSS with asset URLs pointed at the current base; never able to close the style tag. */
export function themeCss(): string {
  const css = active.css.replaceAll(ASSET_BASE, assetBase);
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

export const assetUrl = (name: string): string => `${assetBase}${name}`;

const decoded = new WeakMap<ThemeAsset, Uint8Array>();

/** The bytes of an asset, or undefined for a name the theme does not have. */
export function assetBody(name: string): { type: string; body: string | Uint8Array } | undefined {
  if (!Object.hasOwn(active.assets, name)) return undefined;
  const a = active.assets[name];
  if (!a) return undefined;
  if (a.text !== undefined) return { type: a.type, body: a.text };
  let bytes = decoded.get(a);
  if (!bytes) {
    bytes = Uint8Array.from(atob(a.base64 ?? ""), (ch) => ch.charCodeAt(0));
    decoded.set(a, bytes);
  }
  return { type: a.type, body: bytes };
}
