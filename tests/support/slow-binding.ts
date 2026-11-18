// A binding for a page that answers each key in three bursts, 100 ms apart, so
// that `settled` can be checked deterministically: it must not be reported
// before the last burst. A real page in a real browser; not a stand-in.
//
// `launch-slow-load` opens the same page from a local server that holds back
// an image the page shows for DVS_PW_SLOW_LOAD_MS (default 35 s, past
// Playwright's 30 s navigation default), so the page's load event comes that
// late: a host too loaded to finish loading the application in 30 s, made
// deterministic.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { Binding } from "../../src/arm.ts";

const binding: Binding = {
  name: "slow redraw",
  roles: {},
  async stage(ctx, use) {
    if (use === "launch-slow") {
      await ctx.open(pathToFileURL(join(import.meta.dirname, "slow-page.html")).href);
      return;
    }
    if (use !== "launch-slow-load") throw new Error(`no stage procedure '${use}'`);
    const delay = Number(process.env.DVS_PW_SLOW_LOAD_MS ?? 35_000);
    const html = readFileSync(join(import.meta.dirname, "slow-page.html"), "utf8")
      .replace("</body>", '<img src="/held.png" alt=""></body>');
    const server = createServer((req, res) => {
      if (req.url === "/held.png") {
        setTimeout(() => { res.writeHead(404); res.end(); }, delay);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    server.unref();
    const port = (server.address() as any).port;
    await ctx.open(`http://127.0.0.1:${port}/`);
  },
  async surface(ctx) {
    const text = await ctx.page!.locator("#text").textContent();
    return { role: "screen", keys: [], props: { text }, x: 0, y: 0, w: 100, h: 20, visible: true,
             children: [] };
  },
  async condition() { return undefined; },
  async resolveChord() { return null; },
};

export default binding;
