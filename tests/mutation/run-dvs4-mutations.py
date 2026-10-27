#!/usr/bin/env python3
"""DVS-4 verification gate: the Playwright arm.

Each arm is a defect in locating, input, observation or the generated protocol
types; the kill command is the arm's lint (type check, generated types,
input rule) followed by `just test` (conformance through the runner with the
planted defects, the protocol check, the arm suite) in a real browser.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mutation_engine import Arm, main  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
S = "src/surface.ts"
A = "src/arm.ts"
P = "src/protocol.ts"

ARMS = [
    Arm("P1", S, "      } else if (pool.length > 1) {", "      } else if (false) {",
        "a locator resolving the first of several candidates instead of reporting ambiguity"),
    Arm("P2", A, "    for (const m of added) await kb.down(KEYS[m] ?? m);",
        "    for (const m of added) void m;", "a click's modifiers dropped"),
    Arm("P3", A, "    this.tree = await this.binding.surface(this.ctx);",
        "    this.tree ??= await this.binding.surface(this.ctx);", "a stale read: the page is not re-read"),
    Arm("P4", P, '  "outcome": "one" | "none" | "ambiguous";', '  "outcome": "one" | "none";',
        "the protocol types drifting from the schema"),
    Arm("P5", A, "    if (action.ext) throw", "    await page.evaluate(() => 0);\n    if (action.ext) throw",
        "script injection on the send path"),
    Arm("P6", A, "        if (quiet >= 2) return true;", "        if (quiet >= 1) return true;",
        "settled after one quiet window: before the page stopped changing"),
    Arm("P6b", A, "    while (Date.now() < deadline) {\n      await sleep(60);",
        "    return true;\n    while (Date.now() < deadline) {\n      await sleep(60);",
        "settled reported at once"),
]

if __name__ == "__main__":
    # fail fast: the type and input-rule gates, then the arm suite, then the
    # conformance suite and the protocol check
    main("dvs4", ROOT, ARMS, ["bash", "-c", "just lint-types lint-input-rule && "
                                              "just build test-arm && just test-conformance test-protocol"])
