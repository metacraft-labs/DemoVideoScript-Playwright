// The surface's instances: a located instance is found again, on a later read
// of the page, by its keys, not by where it sat among its siblings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BackendError, SurfaceIndex, type SurfaceNode } from "../src/surface.ts";

function screen(rows: string[]): SurfaceNode {
  return {
    role: "window", keys: [], props: {}, x: 0, y: 0, w: 100, h: 100, visible: true,
    children: rows.map((r, i) => ({
      role: "row", keys: [["text", r]], props: { text: r }, x: 0, y: i, w: 100, h: 1, visible: true, children: [],
    })),
  } as unknown as SurfaceNode;
}

const row = (text: string, ordinal?: number) =>
  ({ segments: [{ role: "row", keys: { text }, ...(ordinal ? { ordinal } : {}) }] }) as any;

function locate(idx: SurfaceIndex, root: SurfaceNode, loc: any): string {
  const r = idx.locate(root, loc);
  assert.equal(r.outcome, "one");
  return (r as { instance: string }).instance;
}

test("a row drawn above it does not move the instance onto another row", () => {
  const idx = new SurfaceIndex();
  const id = locate(idx, screen(["a", "b", "c"]), row("b"));
  assert.equal(idx.lookup(screen(["new", "a", "b", "c"]), id).props.text, "b");
});

test("a row removed above it does not move the instance onto another row", () => {
  const idx = new SurfaceIndex();
  const id = locate(idx, screen(["a", "b", "c"]), row("c"));
  assert.equal(idx.lookup(screen(["b", "c"]), id).props.text, "c");
});

test("an instance that left the page is gone", () => {
  const idx = new SurfaceIndex();
  const id = locate(idx, screen(["a", "b"]), row("b"));
  assert.throws(() => idx.lookup(screen(["a"]), id), BackendError);
});

test("of siblings that share their keys, the instance keeps its place", () => {
  const idx = new SurfaceIndex();
  const id = locate(idx, screen(["x", "x", "y"]), row("x", 2));
  const later = screen(["y", "x", "x"]);
  assert.equal(idx.lookup(later, id), later.children[2]);
});
