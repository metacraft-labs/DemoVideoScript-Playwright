// dvs-playwright: the Playwright arm, serving DemoVideoScript's backend
// protocol as JSON lines on stdin and stdout.
//
//   node src/main.ts --binding <module.ts> [--defect stale-read|off-by-one|early-sync|read-side-effect]
//
// The binding module's default export is a Binding. Playwright is
// `playwright-core` (the dev shell links the one whose browsers it provides).
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Arm } from "./arm.ts";
import type { Binding, Defect } from "./arm.ts";
import { BackendError } from "./surface.ts";

const args = process.argv.slice(2);
let bindingPath = "";
let defect: Defect = "none";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--binding") bindingPath = args[++i];
  else if (args[i] === "--defect") defect = args[++i] as Defect;
  else if (args[i].startsWith("--defect=")) defect = args[i].slice(9) as Defect;
  else {
    console.error("usage: main.ts --binding <module.ts> [--defect NAME]");
    process.exit(64);
  }
}
if (!bindingPath) {
  console.error("usage: main.ts --binding <module.ts> [--defect NAME]");
  process.exit(64);
}

const { chromium } = await import("playwright-core");
const binding: Binding = (await import(pathToFileURL(resolve(bindingPath)).href)).default;
const arm = new Arm(binding, defect, chromium);

const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue: Promise<void> = Promise.resolve();
rl.on("line", (line) => {
  queue = queue.then(async () => {
    if (!line.trim()) return;
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      out({ id: null, ok: false, error: { kind: "protocol", message: `not JSON: ${line.slice(0, 80)}` } });
      return;
    }
    try {
      const res = await arm.handle(req);
      out({ ...res, id: req.id, ok: true });
    } catch (e: any) {
      const kind = e instanceof BackendError ? e.kind : "internal";
      out({ id: req.id ?? null, ok: false, error: { kind, message: String(e?.message ?? e) } });
    }
    if (req.call === "shutdown") process.exit(0);
  });
});
rl.on("close", () => {
  queue.then(() => arm.close()).then(() => process.exit(0));
});
// A stopped arm closes its browser: an orphaned browser would hold the
// runner's pipes open.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    arm.close().finally(() => process.exit(sig === "SIGTERM" ? 143 : 130));
  });
}
