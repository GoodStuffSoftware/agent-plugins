// Hono app for pages only; OAuth and MCP routes stay out of Hono (ARCHITECTURE s.1.2, N4).
// Each page module adds one `app.route()` line.

import { Hono } from "hono";
import { notice } from "../auth/consent";
import type { Env } from "../env";
import { accountsRoutes } from "./accounts";
import { guardrailsRoutes } from "./guardrails";
import { withSecurityHeaders } from "./html";
import { publicRoutes } from "./public";
import { themeRoutes } from "./theme-routes";

export const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.res = withSecurityHeaders(c.res);
});

// Error pages use the same layout as every other page (`notice` is `page()` around a small card).
app.notFound(() => withSecurityHeaders(notice(404, "Not found", "There is nothing at this address.")));
app.onError((err) => {
  console.error(`page error: ${err instanceof Error ? err.name : "unknown"}`);
  return withSecurityHeaders(
    notice(500, "Something went wrong", "This page could not be shown. Try again in a moment."),
  );
});

app.route("/", publicRoutes);
app.route("/theme", themeRoutes);
app.route("/accounts", accountsRoutes);
app.route("/", guardrailsRoutes());
