// The arm's own page recorder (src/recorder.ts) on a real page in a real
// browser, decoded with the real ffmpeg: the video is as long as the
// recording was on the wall clock, whether the page repaints all the time or
// never, and its frames are the page's pixels, unchanged. No stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { PageRecorder, RECORDING_FPS } from "../src/recorder.ts";

const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function duration(video: string): number {
  const r = spawnSync(ffmpeg.replace(/ffmpeg$/, "ffprobe"), ["-v", "error", "-show_entries",
    "format=duration", "-of", "csv=p=0", video], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim()) * 1000;
}

/** A video frame, or a PNG, as raw RGB bytes. */
function rgb(input: string, seek?: number): Buffer {
  const r = spawnSync(ffmpeg, ["-v", "error", ...(seek === undefined ? [] : ["-ss", String(seek)]),
    "-i", input, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}

// a page that repaints on every animation frame, and one that never does
const BUSY = `<body style="margin:0"><div id="n" style="font:40px monospace"></div><script>
  let k = 0; (function f() { document.getElementById("n").textContent = k++; requestAnimationFrame(f); })();
</script></body>`;
const STILL = `<body style="margin:0;background:#fdf6e3"><p style="font:14px monospace;color:#268bd2">
  if (x &lt; 10) { return f(x) + g(y); }</p><div style="width:37px;height:11px;background:#d33682"></div></body>`;

// the frames so far are in the file while it records: a page that repaints
// fills more than a kilobyte in 3 s; one that never does compresses to less,
// but is in the file all the same
for (const [name, html, soFar] of [["repaints all the time", BUSY, 1_000], ["never repaints", STILL, 0]] as const) {
  test(`a page that ${name} is recorded for as long as the recording ran`, { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "dvs-pw-recorder-"));
    const browser = await chromium.launch();
    let rec: PageRecorder | undefined;
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await page.setContent(html);
      const file = join(dir, "page.mkv");
      rec = await PageRecorder.start(page, file);
      await sleep(3_000);
      // encoded as it goes: the frames so far are in the file already
      const size = statSync(file).size;
      assert.ok(size > soFar, `${size} bytes in the file while recording`);
      const stoppedAt = Date.now();
      const written = await rec.stop();
      const wall = stoppedAt - rec.startedAt;
      const frame = 1000 / RECORDING_FPS;
      assert.ok(Math.abs(written - wall) <= 2 * frame, `wrote ${written} ms for ${wall} ms`);
      const d = duration(file);
      assert.ok(Math.abs(d - wall) <= 2 * frame + 50, `the video is ${d} ms, the recording ${wall} ms`);
    } finally {
      await rec?.stop().catch(() => {});
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the recording is the page's pixels, at the page's size", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "dvs-pw-recorder-"));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 641, height: 359 } });
    await page.setContent(STILL);
    const shot = join(dir, "page.png");
    await page.screenshot({ path: shot });
    const file = join(dir, "page.mkv");
    const rec = await PageRecorder.start(page, file);
    await sleep(1_000);
    await rec.stop();
    const size = spawnSync(ffmpeg.replace(/ffmpeg$/, "ffprobe"), ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,codec_name,pix_fmt", "-of", "csv=p=0", file], { encoding: "utf8" });
    // an odd size, kept: RGB needs no even dimensions, so nothing is padded or scaled
    assert.equal(size.stdout.trim(), "h264,641,359,gbrp");
    const want = rgb(shot);
    assert.equal(want.length, 641 * 359 * 3);
    assert.ok(rgb(file, 0.5).equals(want), "the frame differs from the page's screenshot");
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
