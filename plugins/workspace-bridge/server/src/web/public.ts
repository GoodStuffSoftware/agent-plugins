// Public pages: `/`, `/privacy` and `/health` (ARCHITECTURE s.2). Generic text: every
// deployment serves the same pages, with its own contact from var `OWNER_CONTACT`.

import { Hono } from "hono";
import { config, type Env } from "../env";
import { VERSION } from "../version";
import { htmlResponse, page } from "./html";
import { homeView, privacyView } from "./views";

export const publicRoutes = new Hono<{ Bindings: Env }>();

publicRoutes.get("/", (c) => {
  return htmlResponse(page("workspace-bridge", homeView(config(c.env).ownerContact)));
});

publicRoutes.get("/privacy", (c) => {
  return htmlResponse(
    page("Privacy policy - workspace-bridge", privacyView(config(c.env).ownerContact)),
  );
});

publicRoutes.get("/health", (c) =>
  c.json({ ok: true, name: "workspace-bridge", version: VERSION }),
);
