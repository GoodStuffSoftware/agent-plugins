// `/theme/assets/<name>`: the theme's SVG images and woff2 fonts, served by the Worker itself so
// the CSP never has to allow another origin. Public on purpose: a sign-in page needs its logo.

import { Hono } from "hono";
import type { Env } from "../env";
import { assetBody } from "./theme";

export const themeRoutes = new Hono<{ Bindings: Env }>();

/** An SVG opened directly (not as an image) may not run script or load anything. */
const ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

themeRoutes.get("/assets/:name", (c) => {
  const asset = assetBody(c.req.param("name"));
  if (!asset) return c.notFound();
  return new Response(asset.body, {
    headers: {
      "content-type": asset.type,
      "cache-control": "public, max-age=3600",
      "content-security-policy": ASSET_CSP,
    },
  });
});
