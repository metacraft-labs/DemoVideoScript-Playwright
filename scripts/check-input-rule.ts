// The input rule (an arm sends input, never shortcuts around it): no script
// injection on the send path of src/arm.ts. Stages and reads may evaluate
// scripts; `send` must use Playwright's mouse and keyboard only.
//
//   node scripts/check-input-rule.ts [file]      (default: src/arm.ts)
//   node scripts/check-input-rule.ts --self-test (the gate fails on a planted call)
import { readFileSync } from "node:fs";

const FORBIDDEN = /\b(evaluate|evaluateHandle|evaluateAll|dispatchEvent|\$eval|\$\$eval|addScriptTag|exposeFunction|exposeBinding|setInputFiles|fill|selectOption|setChecked|check|uncheck)\s*\(/;

export function violations(source: string): string[] {
  const start = source.indexOf("// --- send: input only");
  const end = source.indexOf("// --- end send");
  if (start < 0 || end < start) return ["the send section markers are missing"];
  const out: string[] = [];
  const lines = source.slice(start, end).split("\n");
  const first = source.slice(0, start).split("\n").length;
  lines.forEach((l, i) => {
    const code = l.replace(/\/\/.*$/, "");
    if (FORBIDDEN.test(code)) out.push(`line ${first + i}: ${l.trim()}`);
  });
  return out;
}

const arg = process.argv[2];
if (arg === "--self-test") {
  const src = readFileSync("src/arm.ts", "utf8");
  const planted = src.replace("// --- end send", "await page.evaluate(() => 0);\n  // --- end send");
  if (violations(src).length !== 0 || violations(planted).length !== 1) {
    console.error("input-rule gate self-test failed");
    process.exit(1);
  }
  console.log("input-rule gate catches a planted page.evaluate");
} else {
  const found = violations(readFileSync(arg ?? "src/arm.ts", "utf8"));
  for (const v of found) console.error("script injection on the send path:", v);
  if (found.length) process.exit(1);
  console.log("input rule: the send path uses only mouse and keyboard input");
}
