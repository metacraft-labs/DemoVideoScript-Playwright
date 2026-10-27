// A surface: the tree of page objects a binding read from the page, and
// locator resolution over it — the same rules as DemoVideoScript's
// surface.nim (one, none or ambiguous, with candidates; semantic keys,
// ordinals, `focused`, `ancestor(role)`). Instance ids are paths of child
// indices, valid until the next input.
import type { Locator, Segment } from "./protocol.ts";

export class BackendError extends Error {
  kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface SurfaceNode {
  role: string;
  keys: Array<[string, string]>;
  props: Record<string, unknown>;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  focused?: boolean;
  unreadable?: Record<string, string>;
  children: SurfaceNode[];
}

export function keyText(n: SurfaceNode): string {
  if (n.keys.length === 0) return n.role;
  return `${n.role}[${n.keys.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}]`;
}

function matches(n: SurfaceNode, seg: Extract<Segment, { role: string }>): boolean {
  if (n.role !== seg.role) return false;
  for (const [k, v] of Object.entries(seg.keys ?? {})) {
    if (!n.keys.some(([kk, vv]) => kk === k && vv === v)) return false;
  }
  return true;
}

function pathTo(cur: SurfaceNode, target: SurfaceNode, path: number[]): boolean {
  if (cur === target) return true;
  for (let i = 0; i < cur.children.length; i++) {
    path.push(i);
    if (pathTo(cur.children[i], target, path)) return true;
    path.pop();
  }
  return false;
}

function parentOf(cur: SurfaceNode, target: SurfaceNode): SurfaceNode | undefined {
  for (const c of cur.children) {
    if (c === target) return cur;
    const p = parentOf(c, target);
    if (p) return p;
  }
  return undefined;
}

function focusedNode(n: SurfaceNode): SurfaceNode | undefined {
  if (n.focused) return n;
  for (const c of n.children) {
    const f = focusedNode(c);
    if (f) return f;
  }
  return undefined;
}

export type LocateResult =
  | { outcome: "one"; instance: string; role: string }
  | { outcome: "none" | "ambiguous"; candidates: string[] };

export class SurfaceIndex {
  private ids = new Map<string, number[]>();
  private next = 0;

  clear(): void {
    this.ids.clear();
  }

  register(root: SurfaceNode, n: SurfaceNode): string {
    const path: number[] = [];
    pathTo(root, n, path);
    const id = `i${++this.next}`;
    this.ids.set(id, path);
    return id;
  }

  lookup(root: SurfaceNode, id: string): SurfaceNode {
    const path = this.ids.get(id);
    if (!path) throw new BackendError("not-found", `no instance ${id}`);
    let n: SurfaceNode | undefined = root;
    for (const i of path) n = n?.children[i];
    if (!n) throw new BackendError("not-found", `instance ${id} is gone`);
    return n;
  }

  locate(root: SurfaceNode, locator: Locator): LocateResult {
    let cur: SurfaceNode | undefined;
    const relative = locator.parent !== undefined;
    if (relative) cur = this.lookup(root, locator.parent!);
    for (let k = 0; k < locator.segments.length; k++) {
      const seg = locator.segments[k];
      if ("focused" in seg) {
        cur = focusedNode(root);
        if (!cur) return { outcome: "none", candidates: ["(nothing has focus)"] };
        continue;
      }
      if ("ancestor" in seg) {
        let a = cur ? parentOf(root, cur) : undefined;
        while (a && a.role !== seg.ancestor) a = parentOf(root, a);
        if (!a) return { outcome: "none", candidates: [] };
        cur = a;
        continue;
      }
      const parent = cur ?? root;
      const pool: SurfaceNode[] = [];
      if (!cur && k === 0 && !relative && matches(root, seg)) pool.push(root);
      for (const c of parent.children) if (matches(c, seg)) pool.push(c);
      const seen = parent.children.filter((c) => c.role === seg.role).map(keyText);
      if (seg.ordinal) {
        if (seg.ordinal > pool.length) return { outcome: "none", candidates: seen };
        cur = pool[seg.ordinal - 1];
      } else if (pool.length === 0) {
        return { outcome: "none", candidates: seen };
      } else if (pool.length > 1) {
        return { outcome: "ambiguous", candidates: pool.map(keyText) };
      } else {
        cur = pool[0];
      }
    }
    if (!cur) return { outcome: "none", candidates: [] };
    return { outcome: "one", instance: this.register(root, cur), role: cur.role };
  }
}

export function readNode(n: SurfaceNode, props: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of props) {
    if (n.unreadable?.[p]) {
      throw new BackendError("unsupported", `'${p}' of ${keyText(n)} cannot be read: ${n.unreadable[p]}`);
    }
    if (p === "geometry") out[p] = { x: n.x, y: n.y, w: n.w, h: n.h, visible: n.visible };
    else if (p === "present") out[p] = true;
    else if (p in n.props) out[p] = n.props[p];
  }
  return out;
}

export function hit(root: SurfaceNode, x: number, y: number): string | null {
  const inside = (n: SurfaceNode) => x >= n.x && x < n.x + n.w && y >= n.y && y < n.y + n.h;
  if (!inside(root)) return null;
  const path = [root];
  for (;;) {
    let next: SurfaceNode | undefined;
    for (const c of path[path.length - 1].children) if (inside(c)) next = c;
    if (!next) break;
    path.push(next);
  }
  const segs: string[] = [];
  for (let k = 1; k < path.length; k++) {
    const n = path[k];
    if (n.keys.length > 0) {
      segs.push(keyText(n));
      continue;
    }
    const same = path[k - 1].children.filter((c) => c.role === n.role);
    segs.push(same.length > 1 ? `${n.role}[#${same.indexOf(n) + 1}]` : n.role);
  }
  return segs.length === 0 ? root.role : segs.join("/");
}
