// The slow-redraw page in a real Electron window, launched with Playwright's
// Electron driver as an Electron application's binding launches it: the arm
// did not open this page, and records it all the same. Electron comes from the
// dev shell (ELECTRON_BIN); it runs headless (Ozone's headless platform), so
// no display is needed.
import { _electron } from "playwright-core";
import type { ElectronApplication } from "playwright-core";
import { join } from "node:path";
import type { Binding } from "../../src/arm.ts";
import slow from "./slow-binding.ts";

let app: ElectronApplication | undefined;

const binding: Binding = {
  ...slow,
  name: "slow redraw in Electron",
  async stage(ctx, use) {
    if (use !== "launch-slow") throw new Error(`no stage procedure '${use}'`);
    app = await _electron.launch({
      executablePath: process.env.ELECTRON_BIN ?? "electron",
      args: [...(process.env.DISPLAY ? [] : ["--ozone-platform=headless"]), "--disable-gpu", "--no-sandbox", join(import.meta.dirname, "electron-app", "main.cjs")],
    });
    ctx.page = await app.firstWindow();
    await ctx.page.waitForLoadState("load");
    ctx.context = ctx.page.context();
  },
  async close() {
    await app?.close().catch(() => {});
    app = undefined;
  },
};
export default binding;
