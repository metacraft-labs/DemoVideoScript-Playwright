// The arm's own recording of a page: the page's screencast through the
// DevTools protocol, as PNG frames, encoded losslessly (H.264 RGB at qp 0,
// in Matroska) at a constant frame rate on the wall clock.
//
// Playwright's own video (`recordVideo`) is not used. It is lossy twice over
// (JPEG frames, then VP8 at 1 Mb/s with 4:2:0 chroma), and each frame is
// shown for as long as the frame's own compositor timestamp says; on a
// loaded host with software GL those timestamps cover a third to two thirds
// of the wall clock, so the video came out that much shorter than the run and
// every step's offset in it was wrong. Here a frame is shown from the moment
// it arrived until the next one arrived, and the last one until the recording
// stops, so the video is as long as the recording was, on the clock the
// runner times steps with.
//
// A page that does not repaint sends no frames: its last frame is repeated.
// The first frame is a screenshot taken at the start, so a page that never
// repaints is still recorded.
import type { CDPSession, Page } from "playwright-core";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BackendError } from "./surface.ts";

/** Frames per second of the recording; the frames are repeated to fill it. */
export const RECORDING_FPS = 15;

export class PageRecorder {
  /** When the video's first frame is shown (epoch ms). */
  readonly startedAt: number;
  readonly file: string;
  private ff: ChildProcess;
  private exited: Promise<number | null>;
  private stderr = "";
  private cdp: CDPSession | undefined;
  private last: Buffer | undefined;
  private written = 0;
  private stopped = false;
  private broken = "";
  private timer: ReturnType<typeof setInterval> | undefined;

  private fps: number;

  private constructor(file: string, startedAt: number, ff: ChildProcess, fps: number) {
    this.file = file;
    this.startedAt = startedAt;
    this.ff = ff;
    this.fps = fps;
    ff.stderr?.on("data", (d) => (this.stderr += String(d)));
    this.exited = new Promise((resolve) => ff.on("close", (code) => resolve(code)));
    ff.on("error", (e) => (this.broken = String(e)));
    ff.stdin?.on("error", (e) => (this.broken ||= String(e)));
  }

  /**
   * Starts recording `page` into `file` (Matroska). The video's time 0 is now.
   */
  static async start(page: Page, file: string, fps = RECORDING_FPS): Promise<PageRecorder> {
    mkdirSync(dirname(file), { recursive: true });
    const startedAt = Date.now();
    const ff = spawn(process.env.FFMPEG_BIN ?? "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      // no probing: the input is known, and probing would hold back the
      // first megabytes of frames instead of encoding them as they come
      "-probesize", "32", "-analyzeduration", "0",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "pipe:0",
      // lossless RGB: the recording is the source of a video, not the video;
      // the composition's one final encode is the only lossy one
      "-c:v", "libx264rgb", "-qp", "0", "-preset", "ultrafast", "-bf", "0", "-pix_fmt", "rgb24",
      // a few encoder threads: x264 holds back as many frames as it has
      // threads, and on a many-core host that kept every frame of a short
      // recording out of the file until the stop
      "-threads", "4",
      // a cluster a second, written out at once: the file keeps up with the
      // recording, and a run that dies keeps the video up to that second
      "-flush_packets", "1", "-cluster_time_limit", "1000",
      "-f", "matroska", file,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    const r = new PageRecorder(file, startedAt, ff, fps);
    try {
      r.cdp = await page.context().newCDPSession(page);
      const shot = await r.cdp.send("Page.captureScreenshot", { format: "png" });
      r.frame(Buffer.from(shot.data, "base64"), startedAt);
      r.cdp.on("Page.screencastFrame", (e) => {
        r.cdp?.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
        r.frame(Buffer.from(e.data, "base64"), Date.now());
      });
      await r.cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      // a page that does not repaint sends no frames: its last frame goes on
      // into the file every second all the same
      r.timer = setInterval(() => r.fill(Date.now()), 1000);
      r.timer.unref();
    } catch (e) {
      await r.abort();
      throw new BackendError("internal", `recording the page: ${String((e as Error)?.message ?? e)}`);
    }
    return r;
  }

  /** The frame shown from `at` (epoch ms) on: the previous one fills the time up to it. */
  private frame(png: Buffer, at: number): void {
    if (this.stopped) return;
    this.fill(at);
    this.last = png;
  }

  /** Repeats the last frame up to the frame slot that `at` falls in. */
  private fill(at: number, inclusive = false): void {
    if (!this.last || this.broken) return;
    const slot = Math.floor(((at - this.startedAt) * this.fps) / 1000) + (inclusive ? 1 : 0);
    while (this.written < slot) {
      this.ff.stdin!.write(this.last);
      this.written++;
    }
  }

  /** Stops recording and finishes the file; returns how long the video is (ms). */
  async stop(): Promise<number> {
    if (this.stopped) return (this.written * 1000) / this.fps;
    // the video ends now: a frame that arrives while the screencast stops is
    // after the end
    const at = Date.now();
    clearInterval(this.timer);
    this.fill(at, true);
    this.stopped = true;
    await this.cdp?.send("Page.stopScreencast").catch(() => {});
    await this.cdp?.detach().catch(() => {});
    this.ff.stdin!.end();
    const code = await this.exited;
    if (code !== 0 || this.broken) {
      throw new BackendError("internal",
        `encoding the recording ${this.file}: ${this.broken || `ffmpeg exited ${code}`} ${this.stderr.trim()}`);
    }
    return (this.written * 1000) / this.fps;
  }

  private async abort(): Promise<void> {
    clearInterval(this.timer);
    this.stopped = true;
    await this.cdp?.detach().catch(() => {});
    this.ff.stdin?.end();
    this.ff.kill("SIGKILL");
    await this.exited;
  }
}
