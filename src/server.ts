import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { config } from "./config.js";
import { Run } from "./pipeline.js";
import { fetchSheetRows } from "./sheet.js";
import { PRIORITIES, type Priority, type RunEvent } from "./types.js";

const runs = new Map<string, Run>();
let active: Run | null = null;

export function createApp() {
  const app = new Hono();

  app.get("/api/sheet", async (c) => {
    const url = c.req.query("url") ?? "";
    const tab = c.req.query("tab") || null;
    try {
      const rows = await fetchSheetRows(url, tab);
      return c.json({ rows });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post("/api/runs", async (c) => {
    if (active && !active.state.finishedAt) return c.json({ error: "A run is already in progress", id: active.state.id }, 409);
    const body = await c.req.json<{ sheetUrl: string; tab: string; priorities?: string[]; dryRun?: boolean }>();
    if (!body.sheetUrl) return c.json({ error: "sheetUrl is required" }, 400);
    const priorities = (body.priorities ?? PRIORITIES).filter((p): p is Priority => (PRIORITIES as string[]).includes(p));
    const run = new Run({ sheetUrl: body.sheetUrl, tab: body.tab ?? "", priorities, dryRun: Boolean(body.dryRun) });
    runs.set(run.state.id, run);
    active = run;
    void run.start().finally(() => {
      // Leave the browser open so the user can check out; it closes when the server exits.
    });
    return c.json({ id: run.state.id });
  });

  app.get("/api/runs", (c) => {
    const live = [...runs.values()].map((r) => summary(r.state));
    let saved: ReturnType<typeof summary>[] = [];
    try {
      saved = readdirSync(config.runsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => summary(JSON.parse(readFileSync(path.join(config.runsDir, f), "utf8"))));
    } catch {
      /* no runs dir yet */
    }
    const byId = new Map<string, ReturnType<typeof summary>>();
    for (const s of [...saved, ...live]) byId.set(s.id, s);
    return c.json({ runs: [...byId.values()].sort((a, b) => b.id.localeCompare(a.id)) });
  });

  app.get("/api/runs/:id", (c) => {
    const id = c.req.param("id");
    const live = runs.get(id);
    if (live) return c.json(live.state);
    try {
      return c.json(JSON.parse(readFileSync(path.join(config.runsDir, `${id}.json`), "utf8")));
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.get("/api/runs/:id/events", (c) => {
    const run = runs.get(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "state", data: JSON.stringify(run.state) });
      if (run.state.finishedAt) return;
      let seq = 0;
      await new Promise<void>((resolve) => {
        const onEvent = (ev: RunEvent) => {
          stream.writeSSE({ event: ev.type, data: JSON.stringify(ev), id: String(seq++) }).catch(() => {});
          if (ev.type === "done") finish();
        };
        const finish = () => {
          run.off("event", onEvent);
          resolve();
        };
        run.on("event", onEvent);
        stream.onAbort(finish);
      });
    });
  });

  app.get("/api/config", (c) =>
    c.json({ shipTo: config.shipTo, currency: config.currency, minStorePositiveRate: config.minStorePositiveRate, minStoreOrders: config.minStoreOrders, hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY) }),
  );

  app.use("/*", serveStatic({ root: "./public" }));
  return app;
}

function summary(s: { id: string; startedAt: string; finishedAt: string | null; phase: string; options: unknown; rows: { status: string }[]; totalLanded: number }) {
  return { id: s.id, startedAt: s.startedAt, finishedAt: s.finishedAt, phase: s.phase, options: s.options, ok: s.rows.filter((r) => r.status === "ok").length, rows: s.rows.length, totalLanded: s.totalLanded };
}

export function startServer() {
  const app = createApp();
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`ali-cart running at http://localhost:${info.port}`);
  });
}
