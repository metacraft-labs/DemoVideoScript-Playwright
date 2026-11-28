// A one-window Electron application on the slow-redraw page: what the
// Electron recording test drives. A real Electron, not a stand-in.
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 640, height: 360, useContentSize: true, show: true });
  w.loadFile(join(__dirname, "..", "slow-page.html"));
});
app.on("window-all-closed", () => app.quit());
