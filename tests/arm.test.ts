// The arm through the real runner, against the conformance application's web
// build in a real browser: recordings, target picking (hit), refusals, and the
// generated protocol types. No stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dvs = process.env.DVS_BIN!;
const dvsRoot = process.env.DVS_ROOT!;
const pack = join(dvsRoot, "conformance/pack/notes-app.pack.yaml");
const scenarios = join(dvsRoot, "conformance/scenarios");
const arm = `cmd:node ${join(root, "src/main.ts")} --binding ${join(root, "conformance/notes-binding.ts")}`;

function run(args: string[]) {
  return spawnSync(dvs, args, { encoding: "utf8", timeout: 600_000 });
}

test("a realistic run records a playable video and a still per step", { timeout: 600_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "dvs-pw-rec-"));
  try {
    const r = run(["run", join(scenarios, "drag-to-reorder.yaml"), "--pack", pack, "--backend", arm,
      "--mode", "realistic", "--record", "always", "--out", dir]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const video = join(dir, "session.webm");
    assert.ok(statSync(video).size > 10_000, "the video has frames");
    // a WebM file starts with the EBML magic
    assert.deepEqual([...readFileSync(video).subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(m.outcome, "passed");
    assert.deepEqual(m.media, [video]);
    for (const s of m.steps) {
      const png = join(dir, "steps", `${s.index}-${s.kind}.png`);
      assert.ok(existsSync(png), png);
      assert.deepEqual([...readFileSync(png).subarray(1, 4)], [0x50, 0x4e, 0x47]); // "PNG"
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing run leaves its recording under the build directory", { timeout: 600_000 }, () => {
  const build = mkdtempSync(join(tmpdir(), "dvs-pw-fail-"));
  try {
    const r = spawnSync(dvs, ["run", join(root, "tests/scenarios/broken-expectation.yaml"), "--pack", pack,
      "--backend", arm], { encoding: "utf8", timeout: 600_000, env: { ...process.env, BUILD_DIR: build } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const group = join(build, "scenario-runs", "playwright-broken-expectation", "playwright");
    const runs = readdirSync(group);
    assert.equal(runs.length, 1);
    const dir = join(group, runs[0]);
    assert.ok(r.stdout.includes(`recording: ${dir}`), r.stdout);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(m.outcome, "failed");
    assert.equal(m.runId, runs[0]);
    for (const f of ["steps/1-state.json", "steps/1-key.png", "steps/2-state.json", "failure/observation.json",
      "failure/surface.png", "failure/backend.log", "session.webm"]) {
      assert.ok(existsSync(join(dir, f)), f);
    }
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
});

test("hit names the page object under a point by its semantic locator", { timeout: 180_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const p = spawn("node", [join(root, "src/main.ts"), "--binding", join(root, "conformance/notes-binding.ts")],
    { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: p.stdout! })[Symbol.asyncIterator]();
  let id = 0;
  async function call(req: Record<string, unknown>): Promise<any> {
    p.stdin!.write(JSON.stringify({ ...req, id: ++id }) + "\n");
    const next = await Promise.race([lines.next(), new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no answer to ${req.call} within 60 s`)), 60_000).unref())]);
    const res = JSON.parse(String(next.value));
    assert.equal(res.id, id);
    assert.equal(res.ok, true, JSON.stringify(res));
    return res;
  }
  try {
    await call({ call: "hello", protocol: 1 });
    await call({ call: "stage", use: "seed-notes",
      with: { fixture: join(dvsRoot, "conformance/fixtures/three-notes.json"), $base: "." } });
    await call({ call: "stage", use: "launch-app", with: { $base: "." } });
    await call({ call: "end-stage" });
    const loc = await call({ call: "locate", locator: { segments: [{ role: "note-list" },
      { role: "note", keys: { title: "Groceries" } }] } });
    const g = (await call({ call: "read", instance: loc.instance, properties: ["geometry"] })).values.geometry;
    const h = await call({ call: "hit", x: g.x + g.w / 2, y: g.y + g.h / 2 });
    assert.equal(h.locator, 'note-list/note[title="Groceries"]');
    const amb = await call({ call: "locate", locator: { segments: [{ role: "note-list" }, { role: "note" }] } });
    assert.equal(amb.outcome, "ambiguous");
    assert.deepEqual(amb.candidates.sort(),
      ['note[title="Groceries"]', 'note[title="Recipes"]', 'note[title="Taxes"]']);
    const none = await call({ call: "locate", locator: { segments: [{ role: "note-list" },
      { role: "note", keys: { title: "Nothing" } }] } });
    assert.equal(none.outcome, "none");
    const outside = await call({ call: "hit", x: -5, y: -5 });
    assert.equal(outside.locator, null);
    await call({ call: "shutdown" });
  } finally {
    p.kill();
    p.stdout!.destroy();
  }
});

test("settled waits for the last of several redraw bursts", { timeout: 300_000 }, () => {
  const slowArm = `cmd:node ${join(root, "src/main.ts")} --binding ${join(root, "tests/support/slow-binding.ts")}`;
  for (let i = 0; i < 3; i++) {
    const r = run(["run", join(root, "tests/scenarios/slow-redraw.yaml"), "--pack",
      join(root, "tests/support/slow.pack.yaml"), "--backend", slowArm, "--record", "off"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
});

test("the protocol types are the schema's: a changed schema makes them stale", { timeout: 60_000 }, () => {
  const schema = JSON.parse(readFileSync(join(dvsRoot, "schemas/v1/backend-protocol.schema.json"), "utf8"));
  execFileSync("node", [join(root, "scripts/gen-protocol-types.ts"),
    join(dvsRoot, "schemas/v1/backend-protocol.schema.json"), "--check"], { cwd: root });
  schema.$defs["response-await"].properties.extra = { type: "string" };
  const dir = mkdtempSync(join(tmpdir(), "dvs-pw-schema-"));
  try {
    const changed = join(dir, "s.json");
    writeFileSync(changed, JSON.stringify(schema));
    const r = spawnSync("node", [join(root, "scripts/gen-protocol-types.ts"), changed, "--check"],
      { cwd: root, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /stale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
