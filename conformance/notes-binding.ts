// The conformance application's DOM binding: its page objects read from its
// web build (DemoVideoScript's conformance/app/web), whose elements carry
// data-role, data-key-<name> and data-props. Reading the DOM is introspection,
// which the format allows for reads; nothing here changes the page except the
// stages, which run before the scenario's steps.
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ArmContext, Binding } from "../src/arm.ts";
import type { SurfaceNode } from "../src/surface.ts";

const KEYMAP: Record<string, string> = {
  "notes.archive-selected": "Ctrl+d", "notes.rename": "F2", "notes.sort": "Ctrl+s",
  "notes.focus-search": "Ctrl+f", "notes.pin": "Ctrl+p",
};

const ALL = ["click", "double-click", "context-click", "drag-source", "drop-target", "wheel",
  "text-entry", "focusable"];

function webDir(): string {
  const d = process.env.DVS_NOTES_WEB;
  if (!d) throw new Error("set DVS_NOTES_WEB to the directory of the notes web build");
  return d;
}

interface Raw {
  role: string;
  keys: Array<[string, string]>;
  props: Record<string, unknown>;
  x: number; y: number; w: number; h: number;
  children: Raw[];
}

async function readDom(ctx: ArmContext): Promise<Raw> {
  // read-only: walks the role elements and returns what they carry
  return await ctx.page!.evaluate(() => {
    function walk(e: Element): any {
      const r = e.getBoundingClientRect();
      const keys: Array<[string, string]> = [];
      for (const a of Array.from(e.attributes)) {
        if (a.name.startsWith("data-key-")) keys.push([a.name.slice(9), a.value]);
      }
      const kids = Array.from(e.children).filter((c) => c.hasAttribute("data-role"));
      return {
        role: e.getAttribute("data-role"), keys,
        props: JSON.parse(e.getAttribute("data-props") ?? "{}"),
        x: r.left, y: r.top, w: r.width, h: r.height, children: kids.map(walk),
      };
    }
    const root = document.querySelector('.roles > [data-role="window"]');
    if (!root) throw new Error("the page has not drawn yet");
    return walk(root);
  });
}

function toNode(raw: Raw, list: { top: number; bottom: number }): SurfaceNode {
  const n: SurfaceNode = {
    role: raw.role, keys: raw.keys, props: raw.props, x: raw.x, y: raw.y, w: raw.w, h: raw.h,
    visible: true, children: [],
  };
  if (raw.role === "note") n.visible = raw.y >= list.top - 0.5 && raw.y + raw.h <= list.bottom + 0.5;
  n.children = raw.children.map((c) => toNode(c, list));
  return n;
}

const binding: Binding = {
  name: "notes-app DOM",
  unit: 20,
  roles: {
    window: { properties: ["title"], affordances: [] },
    "note-list": { properties: ["count", "order", "first-visible"], affordances: ALL },
    note: { properties: ["title", "selected", "pinned", "body", "tags", "position", "state"], affordances: ALL },
  },

  async stage(ctx, use, args) {
    switch (use) {
      case "seed-notes": {
        const f = String(args.fixture);
        ctx.state.fixture = readFileSync(isAbsolute(f) ? f : join(ctx.base, f), "utf8");
        return;
      }
      case "launch-app": {
        const w = Number(args.width ?? 60);
        const h = Number(args.height ?? 16);
        const url = pathToFileURL(resolve(webDir(), "index.html")).href + `?w=${w}&h=${h}`;
        const page = await ctx.open(url, {
          script: (f: string) => { (window as any).DVS_FIXTURE = f; },
          arg: ctx.state.fixture ?? "",
          width: Math.ceil(w * 10 + 20), height: Math.ceil(h * 20 + 20),
        });
        await page.waitForSelector('[data-role="window"]');
        ctx.state.cellWidth = await page.evaluate(
          () => document.getElementById("probe")!.getBoundingClientRect().width);
        return;
      }
      case "set-clock":
        return;
      case "mark-started": {
        const p = String(args.path);
        (await import("node:fs")).writeFileSync(isAbsolute(p) ? p : join(ctx.base, p), "the stage ran\n");
        return;
      }
    }
    throw new Error(`no stage procedure '${use}'`);
  },

  async surface(ctx) {
    const raw = await readDom(ctx);
    const listRaw = raw.children.find((c) => c.role === "note-list");
    const list = listRaw ? { top: listRaw.y, bottom: listRaw.y + listRaw.h } : { top: 0, bottom: 1e9 };
    const root = toNode(raw, list);
    // focus: the dialog's field, else the search field when it has focus, else the list
    const dialog = root.children.find((c) => c.role === "dialog");
    const search = root.children.find((c) => c.role === "search-field");
    const field = dialog?.children.find((c) => c.role === "text-field");
    if (field) field.focused = true;
    else if (search?.props.focused) search.focused = true;
    else {
      const l = root.children.find((c) => c.role === "note-list");
      if (l) l.focused = true;
    }
    return root;
  },

  async condition(ctx, name) {
    if (name === "note-list.loaded" || name === "idle") {
      const root = await this.surface(ctx);
      const status = root.children.find((c) => c.role === "status-bar");
      return status?.props.message !== "Loading...";
    }
    return undefined;
  },

  async resolveChord(_ctx, operation) {
    return KEYMAP[operation] ?? null;
  },

  async anchor(ctx, n, anchor) {
    const cw = Number(ctx.state.cellWidth ?? 9.6);
    const name = anchor.split("(")[0];
    const y = n.y + n.h / 2;
    if (name === "handle") return { x: n.x + 1.5 * cw, y };
    if (name === "title-end") return { x: n.x + (4 + String(n.props.title).length - 0.5) * cw, y };
    if (name === "caret-at") return { x: n.x + (Number(anchor.slice(anchor.indexOf("(") + 1, -1)) + 0.5) * cw, y };
    return undefined;
  },
};

export default binding;
