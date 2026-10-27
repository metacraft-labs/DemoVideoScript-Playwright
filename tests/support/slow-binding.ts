// A binding for a page that answers each key in three bursts, 100 ms apart, so
// that `settled` can be checked deterministically: it must not be reported
// before the last burst. A real page in a real browser; not a stand-in.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { Binding } from "../../src/arm.ts";

const binding: Binding = {
  name: "slow redraw",
  roles: {},
  async stage(ctx, use) {
    if (use !== "launch-slow") throw new Error(`no stage procedure '${use}'`);
    await ctx.open(pathToFileURL(join(import.meta.dirname, "slow-page.html")).href);
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
