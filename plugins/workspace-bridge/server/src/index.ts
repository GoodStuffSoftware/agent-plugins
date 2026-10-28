import { Hono } from "hono";
import { VERSION } from "./version";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, name: "workspace-bridge", version: VERSION }));

export default app;
