// The Playwright arm: DemoVideoScript's backend protocol answered through
// Playwright, for web and Electron applications.
//
// It contains no matching, waiting or timing logic of its own (the runner owns
// those): it answers locate, read, send, await, record and hit. A project
// supplies a Binding: its stages (which launch the application), how its page
// objects are read from the page, the conditions it detects, its binding
// resolver. Input goes through Playwright's mouse and keyboard — real browser
// events — and never through script injection (scripts/check-input-rule.ts
// enforces that on the send path); stages and reads may inject scripts, reads
// may not change the application (the runner probes for it).
import type { Browser, BrowserContext, Page } from "playwright-core";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PageRecorder } from "./recorder.ts";
import { BackendError, hit, readNode, SurfaceIndex } from "./surface.ts";
import type { SurfaceNode } from "./surface.ts";
import type { Locator } from "./protocol.ts";

export type Defect = "none" | "stale-read" | "off-by-one" | "early-sync" | "read-side-effect";

export interface ArmContext {
  browser: Browser | undefined;
  context: BrowserContext | undefined;
  page: Page | undefined;
  base: string;
  state: Record<string, unknown>;
  /**
   * Where a binding that also records with Playwright's own `recordVideo`
   * keeps it, and when that video began (epoch ms). The arm does not use
   * Playwright's video: it records every page itself while a recording runs
   * (src/recorder.ts), so these are only the binding's.
   */
  videoDir: string;
  videoStartedAt: number;
  /**
   * True: the arm records every page of the application itself while a
   * recording runs, a page a binding opened (an Electron window) as well, so
   * a binding has no need to ask Playwright for a video of its own. An older
   * arm, which copied the page's Playwright video, leaves it unset.
   */
  readonly recordsPages: true;
  /** Opens the application's page, in a new browser context. */
  open(url: string, init?: { script?: string | ((arg: any) => void); arg?: unknown; width?: number; height?: number }): Promise<Page>;
}

export interface Binding {
  name: string;
  roles: Record<string, { affordances: string[]; properties: string[] }>;
  stage(ctx: ArmContext, use: string, args: Record<string, unknown>): Promise<void>;
  surface(ctx: ArmContext): Promise<SurfaceNode>;
  condition(ctx: ArmContext, name: string): Promise<boolean | undefined>;
  resolveChord(ctx: ArmContext, operation: string): Promise<string | null>;
  anchor?(ctx: ArmContext, n: SurfaceNode, anchor: string): Promise<{ x: number; y: number } | undefined>;
  /** One cell or pixel, in the page's units: what the off-by-one arm moves by. */
  unit?: number;
  /**
   * Closes what the binding's stages started, when that is not a page the arm
   * opened (an Electron application started with Playwright's Electron
   * driver, say). Called when a recording stops, after the arm has finished
   * recording its pages, and when the arm shuts down. Without it the arm
   * closes the browser context it opened.
   */
  close?(ctx: ArmContext): Promise<void>;
  /**
   * Opens one more client of the application (a scenario's `clients:` or
   * `open-client`): `kind` is the pack's client kind, `isolation` what it
   * shares with the others. Returns its page. Without it the arm opens the
   * address of the client open now: in a new browser context for `separate`
   * (nothing shared, as a second browser), in the same context for `shared`
   * (as a second tab).
   */
  openClient?(ctx: ArmContext, kind: string, isolation: "separate" | "shared"): Promise<Page>;
  /**
   * An `act` step (DemoVideoScript-pm Proposal-Outside-Actions.md): a change
   * outside the application, by the pack's action name and its arguments —
   * another program writing a file, a second process of the product. Never
   * the application's own state. Without it the arm does not offer `act`.
   */
  act?(ctx: ArmContext, use: string, args: Record<string, unknown>): Promise<void>;
}

/** One client of the application: a page, and the context it lives in. */
interface Client {
  page: Page;
  context: BrowserContext | undefined;
  /** A context the arm opened for this client, closed with it. */
  ownContext: boolean;
}

const CAPABILITIES = [
  "input.key", "input.chord", "input.text", "input.pointer.move", "input.pointer.click",
  "input.pointer.drag", "input.wheel", "input.hover",
  "observe.text", "observe.geometry", "observe.focus", "sync.event", "sync.visual-settle",
  "record.video", "record.still",
  "client.multi", "client.reload", "client.duplicate",
  "client.isolation.separate", "client.isolation.shared",
];

const KEYS: Record<string, string> = {
  Enter: "Enter", Esc: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
  Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Space: " ",
  Plus: "+", Menu: "ContextMenu", Ctrl: "Control", Shift: "Shift", Alt: "Alt", Meta: "Meta",
};

function pwKey(key: string): string {
  if (KEYS[key]) return KEYS[key];
  if (/^F\d{1,2}$/.test(key)) return key;
  return key;
}

function pwChord(chord: string): string {
  const parts = chord.split("+");
  return parts.map((p, i) => (i < parts.length - 1 ? KEYS[p] ?? p : pwKey(p))).join("+");
}

// Opening (the stage's first page as well as a client's), duplicating or
// reloading a client waits for the page's load event,
// as a person waits for the tab to stop loading, with a limit far above
// Playwright's 30 s default: an application that starts a replay per client
// can take minutes to finish loading on a loaded machine. Whether the
// application in it is ready is the scenario's to wait for.
const OPEN_WAIT = { waitUntil: "load" as const, timeout: 600_000 };

/** A settled wait that saw the surface change this recently reports progress. */
const PROGRESS_WINDOW_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function parseDuration(s: string): number {
  if (s.endsWith("ms")) return parseFloat(s);
  if (s.endsWith("s")) return parseFloat(s) * 1000;
  if (s.endsWith("m")) return parseFloat(s) * 60000;
  return parseFloat(s) * 1000;
}

export class Arm {
  private idx = new SurfaceIndex();
  private tree: SurfaceNode | undefined;
  private before: SurfaceNode | undefined;
  private stageClosed = false;
  private held = new Set<string>();
  private recording: { dir: string; startedAt: number } | undefined;
  private clients = new Map<string, Client>();
  readonly ctx: ArmContext;
  private binding: Binding;
  private defect: Defect;
  private chromium: any;

  constructor(binding: Binding, defect: Defect, chromium: any) {
    this.binding = binding;
    this.defect = defect;
    this.chromium = chromium;
    const self = this;
    this.ctx = {
      browser: undefined, context: undefined, page: undefined, base: ".", state: {},
      videoDir: "",
      videoStartedAt: 0,
      recordsPages: true,
      async open(url, init) {
        self.ctx.browser ??= await self.chromium.launch();
        const width = init?.width ?? 1024;
        const height = init?.height ?? 600;
        self.ctx.context = await self.ctx.browser!.newContext({ viewport: { width, height } });
        const page = await self.ctx.context.newPage();
        // on the context, so every page of the application gets it: a second
        // tab (a shared client, a duplicated one) as well as the first
        if (init?.script) await self.ctx.context.addInitScript(init.script as any, init.arg);
        await page.goto(url, OPEN_WAIT);
        self.ctx.page = page;
        return page;
      },
    };
  }

  private page(): Page {
    if (!this.ctx.page) throw new BackendError("internal", "the application is not open (no stage opened it)");
    return this.ctx.page;
  }

  private async refresh(): Promise<SurfaceNode> {
    this.page();
    this.tree = await this.binding.surface(this.ctx);
    return this.tree;
  }

  private async point(id: string, anchor?: string): Promise<{ x: number; y: number }> {
    const root = await this.refresh();
    const n = this.idx.lookup(root, id);
    let p = { x: n.x + n.w / 2, y: n.y + n.h / 2 };
    if (anchor && anchor !== "center") {
      const a = this.binding.anchor ? await this.binding.anchor(this.ctx, n, anchor) : undefined;
      if (!a) throw new BackendError("unsupported", `no anchor '${anchor}' on ${n.role}`);
      p = a;
    }
    if (this.defect === "off-by-one") p = { x: p.x, y: p.y + (this.binding.unit ?? 1) };
    return p;
  }

  private modifiers(extra: string[] = []): string[] {
    return [...new Set([...this.held, ...extra])].map((m) => KEYS[m] ?? m);
  }

  private async withModifiers<T>(mods: string[], f: () => Promise<T>): Promise<T> {
    const kb = this.page().keyboard;
    const added = mods.filter((m) => !this.held.has(m));
    for (const m of added) await kb.down(KEYS[m] ?? m);
    try {
      return await f();
    } finally {
      for (const m of added.reverse()) await kb.up(KEYS[m] ?? m);
    }
  }

  private async followPath(path: Array<[number, number, number]> | undefined, steps = 1): Promise<void> {
    if (!path) return;
    const mouse = this.page().mouse;
    let last = 0;
    for (const [x, y, t] of path) {
      await sleep(t - last);
      last = t;
      await mouse.move(x, y, { steps });
    }
  }

  // --- send: input only -----------------------------------------------------
  // Everything below up to "end send" delivers input through Playwright's
  // mouse and keyboard. scripts/check-input-rule.ts refuses script injection
  // here.
  private async send(action: any): Promise<void> {
    const page = this.page();
    const mouse = page.mouse;
    const kb = page.keyboard;
    this.before = await this.refresh();
    const targets = action.targets ?? {};
    const timing = action.timing ?? {};
    if (action.ext) throw new BackendError("unsupported", `no extension step '${action.ext}'`);
    if (action.key !== undefined) {
      const key = typeof action.key === "string" ? action.key : action.key.key;
      await kb.press([...this.modifiers(), pwKey(key)].join("+"));
    } else if (action.chord !== undefined) {
      for (const c of String(action.chord).split(" ")) await kb.press(pwChord(c));
    } else if (action.type !== undefined) {
      const text: string = typeof action.type === "string" ? action.type : action.type.text;
      const delays: number[] = timing.keyDelaysMs ?? [];
      let k = 0;
      for (const ch of text) {
        await sleep(delays[k++] ?? 0);
        await kb.type(ch);
      }
    } else if (action.press !== undefined || action.release !== undefined) {
      const isPress = action.press !== undefined;
      const v = isPress ? action.press : action.release;
      if (v.key !== undefined) {
        if (isPress) {
          await kb.down(pwKey(v.key));
          this.held.add(v.key);
        } else {
          await kb.up(pwKey(v.key));
          this.held.delete(v.key);
        }
      } else {
        const p = await this.point(targets.target, v.anchor);
        await mouse.move(p.x, p.y);
        const button = v.button ?? "left";
        if (isPress) await mouse.down({ button });
        else await mouse.up({ button });
      }
    } else if (action.move !== undefined || action.hover !== undefined) {
      const v = action.move ?? action.hover;
      await this.followPath(timing.path);
      const p = await this.point(targets.target, v.anchor);
      await mouse.move(p.x, p.y);
      if (action.hover?.for) await sleep(parseDuration(action.hover.for));
    } else if (action.click !== undefined) {
      const v = action.click;
      await this.followPath(timing.path);
      const p = await this.point(targets.target, v.anchor);
      await this.withModifiers(v.modifiers ?? [], () =>
        mouse.click(p.x, p.y, { button: v.button ?? "left", clickCount: v.count ?? 1 }));
    } else if (action.drag !== undefined) {
      const v = action.drag;
      const from = await this.point(targets.from, typeof v.from === "object" ? v.from.anchor : undefined);
      const via: Array<{ x: number; y: number }> = [];
      for (const id of targets.via ?? []) via.push(await this.point(id));
      const to = await this.point(targets.to, typeof v.to === "object" ? v.to.anchor : undefined);
      const button = v.button ?? "left";
      await this.withModifiers(v.modifiers ?? [], async () => {
        await this.followPath(timing.approach);
        await mouse.move(from.x, from.y);
        await mouse.down({ button });
        for (const w of via) await mouse.move(w.x, w.y, { steps: 4 });
        await this.followPath(timing.path, 2);
        await mouse.move(to.x, to.y, { steps: 4 });
        await mouse.up({ button });
      });
    } else if (action.wheel !== undefined) {
      const v = action.wheel;
      const p = await this.point(targets.target, v.anchor);
      await mouse.move(p.x, p.y);
      const unit = 100;
      const [dx, dy] = { up: [0, -unit], down: [0, unit], left: [-unit, 0], right: [unit, 0] }[
        v.direction as "up" | "down" | "left" | "right"];
      for (let k = 0; k < (v.amount ?? 1); k++) await mouse.wheel(dx, dy);
    } else {
      throw new BackendError("protocol", `send: no input action in ${JSON.stringify(action)}`);
    }
    this.idx.clear();
  }
  // --- end send ---------------------------------------------------------------

  /** When the surface last changed during a settled wait (epoch ms). */
  private lastChange = 0;

  private async settled(timeoutMs: number): Promise<boolean> {
    // the page stopped changing: three reads of the surface, 60 ms apart,
    // agree (two consecutive quiet windows, as the terminal backend requires)
    const deadline = Date.now() + timeoutMs;
    let last = JSON.stringify(await this.binding.surface(this.ctx));
    let quiet = 0;
    this.lastChange = 0;
    while (Date.now() < deadline) {
      await sleep(60);
      const now = JSON.stringify(await this.binding.surface(this.ctx));
      if (now === last) {
        quiet++;
        if (quiet >= 2) return true;
      } else {
        quiet = 0;
        this.lastChange = Date.now();
      }
      last = now;
    }
    return false;
  }

  /**
   * Not settled, but still changing when the wait ended: the surface changed
   * within the last second of it. The runner then waits on, up to its settle
   * cap, instead of failing a page that is still drawing (a heavy redraw on a
   * loaded host takes longer than one settle timeout).
   */
  private stillChanging(): boolean {
    return this.lastChange > 0 && Date.now() - this.lastChange < PROGRESS_WINDOW_MS;
  }

  async handle(req: any): Promise<Record<string, unknown>> {
    switch (req.call) {
      case "hello":
        return {
          backend: "playwright", version: "1", platform: process.platform === "darwin" ? "macos" :
            process.platform === "win32" ? "windows" : "linux",
          capabilities: this.binding.act ? [...CAPABILITIES, "act"] : CAPABILITIES,
          bindings: this.binding.roles, units: "px",
        };
      case "stage":
        if (this.stageClosed) throw new BackendError("stage-closed", `the stage has ended; '${req.use}' cannot run now`);
        this.ctx.base = req.with?.$base ?? ".";
        try {
          await this.binding.stage(this.ctx, req.use, req.with ?? {});
        } catch (e: any) {
          if (e instanceof BackendError) throw e;
          throw new BackendError("stage", `${req.use}: ${e?.message ?? e}`);
        }
        return {};
      case "end-stage":
        this.stageClosed = true;
        return {};
      case "resolve-chord":
        return { chord: await this.binding.resolveChord(this.ctx, req.operation) };
      case "locate": {
        const root = await this.refresh();
        return this.idx.locate(root, req.locator as Locator);
      }
      case "read": {
        const root = this.defect === "stale-read" && this.before ? this.before : await this.refresh();
        const n = this.idx.lookup(root, req.instance);
        const values = readNode(n, req.properties);
        if (this.defect === "read-side-effect" && n.role !== root.role) {
          await this.withModifiers(["Ctrl"], () => this.page().mouse.click(n.x + 2, n.y + n.h / 2));
        }
        return { values };
      }
      case "send":
        await this.send(req.action);
        return {};
      case "await": {
        if (this.defect === "early-sync") return { met: true };
        if (req.condition === "settled") {
          if (await this.settled(req.timeoutMs)) return { met: true };
          if (!this.stillChanging()) return { met: false };
          return {
            met: false,
            progress: true,
            reason: `the page was still changing: it last changed ${Date.now() - this.lastChange} ms before the wait ended`,
          };
        }
        const deadline = Date.now() + req.timeoutMs;
        for (;;) {
          const met = await this.binding.condition(this.ctx, req.condition);
          if (met === undefined) {
            throw new BackendError("unsupported", `the ${this.binding.name} binding cannot detect '${req.condition}'`);
          }
          if (met) return { met: true };
          if (Date.now() > deadline) return { met: false };
          await sleep(20);
        }
      }
      case "record":
        return await this.record(req);
      case "hit":
        return { locator: hit(await this.refresh(), req.x, req.y) };
      case "client":
        await this.client(req);
        return {};
      case "act":
        if (!this.binding.act) throw new BackendError("unsupported", "this binding makes no changes outside the application");
        try {
          await this.binding.act(this.ctx, req.use, req.with ?? {});
        } catch (e: any) {
          if (e instanceof BackendError) throw e;
          throw new BackendError("refused", `act ${req.use}: ${e?.message ?? e}`);
        }
        return {};
      case "shutdown":
        await this.close();
        return {};
      default:
        throw new BackendError("protocol", `unknown call '${req.call}'`);
    }
  }

  // --- clients ----------------------------------------------------------------
  // What a person does to a client as a whole: open one more, reload it,
  // duplicate it, close it. The calls after `select` are that client's.
  private use(name: string): Client {
    const c = this.clients.get(name);
    if (!c) throw new BackendError("not-found", `no client '${name}'`);
    return c;
  }

  private async client(req: any): Promise<void> {
    const name: string = req.name;
    switch (req.op) {
      case "adopt":
        this.stageContext = this.ctx.context;
        this.clients.set(name, { page: this.page(), context: this.ctx.context, ownContext: false });
        await this.recordPage(this.page());
        return;
      case "open": {
        const isolation = req.isolation === "shared" ? "shared" : "separate";
        let page: Page;
        let ownContext = false;
        if (this.binding.openClient) {
          page = await this.binding.openClient(this.ctx, req.open, isolation);
        } else {
          const url = this.page().url();
          if (isolation === "shared") {
            if (!this.ctx.context) throw new BackendError("unsupported", "no context to open a tab in");
            page = await this.ctx.context.newPage();
          } else {
            this.ctx.browser ??= await this.chromium.launch();
            const vp = this.page().viewportSize() ?? { width: 1024, height: 600 };
            const context = await this.ctx.browser!.newContext({ viewport: vp });
            page = await context.newPage();
            ownContext = true;
          }
          await page.goto(url, OPEN_WAIT);
        }
        this.clients.set(name, { page, context: page.context(), ownContext });
        await this.recordPage(page);
        return;
      }
      case "duplicate": {
        // what a browser's "Duplicate" does: a second tab of the same browser
        // whose session storage starts as a copy of the original's
        const from = this.use(req.from);
        const storage: Record<string, string> = await from.page.evaluate(() => {
          const o: Record<string, string> = {};
          for (let k = 0; k < sessionStorage.length; k++) {
            const key = sessionStorage.key(k)!;
            o[key] = sessionStorage.getItem(key)!;
          }
          return o;
        });
        const page = await from.page.context().newPage();
        await page.addInitScript((seed: Record<string, string>) => {
          // only into the tab's first document: its own reloads keep its own
          if (sessionStorage.length === 0) {
            for (const [k, v] of Object.entries(seed)) sessionStorage.setItem(k, v);
          }
        }, storage);
        await page.goto(from.page.url(), OPEN_WAIT);
        this.clients.set(name, { page, context: page.context(), ownContext: false });
        await this.recordPage(page);
        return;
      }
      case "select": {
        const c = this.use(name);
        this.ctx.page = c.page;
        this.ctx.context = c.context;
        this.idx.clear();
        this.tree = undefined;
        this.before = undefined;
        return;
      }
      case "reload": {
        await this.use(name).page.reload(OPEN_WAIT);
        this.idx.clear();
        return;
      }
      case "close": {
        const c = this.use(name);
        this.clients.delete(name);
        if (this.ctx.page === c.page) this.ctx.page = undefined;
        const recorder = this.recorders.get(c.page);
        if (recorder) {
          this.recorders.delete(c.page);
          await recorder.stop();
          this.closedVideos.push({ name, recorder });
        }
        await c.page.close().catch(() => {});
        if (c.ownContext) await c.context?.close().catch(() => {});
        this.idx.clear();
        return;
      }
    }
    throw new BackendError("protocol", `unknown client op '${req.op}'`);
  }

  private stageContext: BrowserContext | undefined;
  /** The pages being recorded now, and the recordings of clients closed meanwhile. */
  private recorders = new Map<Page, PageRecorder>();
  private closedVideos: Array<{ name: string; recorder: PageRecorder }> = [];

  /** While a recording runs, every page of the application is recorded. */
  private async recordPage(page: Page): Promise<void> {
    const rec = this.recording;
    if (!rec || this.recorders.has(page)) return;
    const file = join(rec.dir, `recording-${this.recorders.size + this.closedVideos.length}.mkv`);
    this.recorders.set(page, await PageRecorder.start(page, file));
  }

  /** Finishes a recording as `<base>.mkv`, with its timing file `<base>.video.json`. */
  private finish(rec: { dir: string; startedAt: number }, recorder: PageRecorder, base: string,
                 extra: Record<string, unknown> = {}): string {
    const out = join(rec.dir, `${base}.mkv`);
    renameSync(recorder.file, out);
    // `leadMs` is how far into the video the recording began, so a step's
    // offset in the video is leadMs + (its startMs - recordingStartMs); a
    // client opened after the recording began has a negative one
    writeFileSync(join(rec.dir, `${base}.video.json`),
      JSON.stringify({ ...extra, videoStartedAt: recorder.startedAt, recordingStartedAt: rec.startedAt,
                       leadMs: rec.startedAt - recorder.startedAt }) + "\n");
    return out;
  }

  /** Each client's video, as session.<client>.mkv with its own timing file. */
  private async clientVideos(rec: { dir: string; startedAt: number }): Promise<string[]> {
    const all = [...this.clients.entries()];
    const files: string[] = [];
    const done: Array<{ name: string; recorder: PageRecorder }> = [];
    for (const [name, client] of all) {
      const recorder = this.recorders.get(client.page);
      if (!recorder) continue;
      this.recorders.delete(client.page);
      await recorder.stop();
      done.push({ name, recorder });
    }
    const stagePage = this.ctx.page;
    for (const [, c] of all) {
      if (c.ownContext) await c.context?.close().catch(() => {});
      else if (c.page !== stagePage) await c.page.close().catch(() => {});
    }
    await this.closeApplication();
    for (const { name, recorder } of [...done, ...this.closedVideos]) {
      files.push(this.finish(rec, recorder, `session.${name}`, { client: name }));
    }
    this.closedVideos = [];
    return files;
  }

  private async record(req: any): Promise<{ files: string[] }> {
    switch (req.op) {
      case "start": {
        this.recording = { dir: req.dir, startedAt: Date.now() };
        mkdirSync(req.dir, { recursive: true });
        // the application's pages open now: the stage's, and any client's
        const pages = new Set<Page>([...this.clients.values()].map((c) => c.page));
        if (this.ctx.page) pages.add(this.ctx.page);
        for (const page of pages) await this.recordPage(page);
        return { files: [] };
      }
      case "mark":
        return { files: [] };
      case "still": {
        const path = join(req.dir ?? ".", `${req.path ?? "still"}.png`);
        mkdirSync(dirname(path), { recursive: true });
        await this.page().screenshot({ path });
        return { files: [path] };
      }
      case "stop": {
        const rec = this.recording;
        this.recording = undefined;
        if (rec && this.clients.size > 0) {
          // more than one client: one video per client, the stage's own too.
          // The stage's application is the page the binding's close closes.
          const adopted = [...this.clients.values()].find((c) => !c.ownContext && c.context === this.stageContext);
          if (adopted) { this.ctx.page = adopted.page; this.ctx.context = adopted.context; }
          const files = await this.clientVideos(rec);
          this.ctx.page = undefined;
          return { files };
        }
        const recorder = this.ctx.page ? this.recorders.get(this.ctx.page) : undefined;
        if (recorder) {
          this.recorders.delete(this.ctx.page!);
          await recorder.stop();
        }
        if (!rec || !this.ctx.page) return { files: [] };
        await this.closeApplication();
        this.ctx.page = undefined;
        if (!recorder) return { files: [] };
        return { files: [this.finish(rec, recorder, "session")] };
      }
    }
    throw new BackendError("protocol", `unknown record op '${req.op}'`);
  }

  private closed = false;

  /** The application the stages opened: the binding's own close, or the context. */
  private async closeApplication(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.binding.close) await this.binding.close(this.ctx).catch(() => {});
    else await this.ctx.context?.close().catch(() => {});
  }

  async close(): Promise<void> {
    // a recording still running when the arm shuts down is abandoned
    for (const r of this.recorders.values()) await r.stop().catch(() => {});
    this.recorders.clear();
    for (const c of this.clients.values()) {
      if (c.ownContext) await c.context?.close().catch(() => {});
    }
    await this.closeApplication();
    await this.ctx.browser?.close().catch(() => {});
  }
}
