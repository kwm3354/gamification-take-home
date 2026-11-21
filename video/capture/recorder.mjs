// Records a page with the DevTools screencast. Frames arrive when the page changes; on stop they are
// turned into a constant 30 fps clip with ffmpeg (each frame held until the next one arrives).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
export async function record(page, name, outDir) {
  const dir = path.join(outDir, "capture", "raw", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.createCDPSession();
  const frames = [];
  const t0 = Date.now();
  const marks = [];
  cdp.on("Page.screencastFrame", async (f) => {
    const file = path.join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
    frames.push({ file, t: Date.now() });
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
    } catch {}
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  return {
    mark(label) {
      marks.push({ label, s: (Date.now() - t0) / 1000 });
      console.log(`[${name}] ${((Date.now() - t0) / 1000).toFixed(2)}s ${label}`);
    },
    async stop() {
      await new Promise((r) => setTimeout(r, 500));
      await cdp.send("Page.stopScreencast");
      const end = Date.now();
      const lines = [];
      frames.forEach((f, i) => {
        const next = i + 1 < frames.length ? frames[i + 1].t : end;
        const start = i === 0 ? t0 : f.t;
        lines.push(`file '${path.resolve(f.file)}'`, `duration ${((next - start) / 1000).toFixed(3)}`);
      });
      lines.push(`file '${path.resolve(frames.at(-1).file)}'`);
      const list = path.join(dir, "list.txt");
      fs.writeFileSync(list, lines.join("\n"));
      const out = path.join(outDir, "public", "clips", `${name}.mp4`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30,scale=1920:1080,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", out]);
      fs.writeFileSync(path.join(outDir, "public", "clips", `${name}.json`), JSON.stringify({ seconds: (end - t0) / 1000, marks }, null, 2));
      console.log(`[${name}] ${frames.length} frames, ${((end - t0) / 1000).toFixed(1)} s -> ${out}`);
    },
  };
}
