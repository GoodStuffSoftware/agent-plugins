// Hono app for pages only; OAuth and MCP routes stay out of Hono (ARCHITECTURE s.1.2, N4).
// Each page module adds one `app.route()` line.

import { Hono } from "hono";
import type { Env } from "../env";
import { withSecurityHeaders } from "./html";
import { publicRoutes } from "./public";

export const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.res = withSecurityHeaders(c.res);
});

app.route("/", publicRoutes);
