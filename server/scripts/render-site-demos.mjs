/** Encode recorded UI clips and their accessible, lightweight website assets. */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const input = process.env.DEMO_OUT_DIR ?? join(process.env.DEMO_DATA_DIR ?? join(tmpdir(), "blattbot-site-demo"), "recordings");
const output = join(root, "docs/assets");
const ffmpeg = process.env.DEMO_FFMPEG ?? "/usr/bin/ffmpeg";
mkdirSync(output, { recursive: true });
const run = args => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
const stamp = seconds => new Date(Math.max(0, seconds) * 1000).toISOString().slice(11, 23);
const shots = { evidence: "research-evidence", graph: "research-graph", writing: "editor-search" };
for (const [clip, shot] of Object.entries(shots)) {
  const meta = JSON.parse(readFileSync(join(input, `${clip}.json`), "utf8"));
  run(["-ss", String(meta.start), "-i", meta.raw, "-t", String(meta.end - meta.start), "-an", "-vf", "fps=24", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(output, `${clip}.mp4`)]);
  run(["-i", join(input, `${shot}.png`), "-frames:v", "1", "-c:v", "libwebp", "-quality", "92", join(output, `${shot}.webp`)]);
  copyFileSync(join(output, `${shot}.webp`), join(output, `${clip}-poster.webp`));
  const cues = meta.marks.map((mark, i) => `${i + 1}\n${stamp(mark.at - meta.start)} --> ${stamp((meta.marks[i + 1]?.at ?? meta.end) - meta.start)}\n${mark.text}\n`).join("\n");
  writeFileSync(join(output, `${clip}.vtt`), `WEBVTT\n\n${cues}`);
  console.log(`Encoded ${clip} (${(meta.end - meta.start).toFixed(1)}s)`);
}
copyFileSync(join(input, "research-evidence.png"), join(output, "demo-poster.png"));
// Refresh the older README media URLs with a short montage from the same real clips.
run(["-i", join(output, "evidence.mp4"), "-i", join(output, "graph.mp4"), "-i", join(output, "writing.mp4"), "-filter_complex", "[0:v]trim=start=3:duration=6,setpts=PTS-STARTPTS[a];[1:v]trim=start=0:duration=6,setpts=PTS-STARTPTS[b];[2:v]trim=start=8:duration=6,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0[out]", "-map", "[out]", "-an", "-c:v", "libx264", "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(output, "demo.mp4")]);
run(["-i", join(output, "demo.mp4"), "-filter_complex", "fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3", "-loop", "0", join(output, "demo.gif")]);
