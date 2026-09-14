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
const shots = { workflow: "workflow-proof", evidence: "research-evidence", graph: "research-graph", writing: "editor-search" };
for (const [clip, shot] of Object.entries(shots)) {
  if (process.env.DEMO_CLIP && process.env.DEMO_CLIP !== clip) continue;
  const meta = JSON.parse(readFileSync(join(input, `${clip}.json`), "utf8"));
  const segments = meta.segments ?? [{ start: meta.start, end: meta.end }];
  const filter = segments.map((segment, i) => `[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${i}]`).join(";") + ";" + segments.map((_, i) => `[v${i}]`).join("") + `concat=n=${segments.length}:v=1:a=0,fps=24[out]`;
  run(["-i", meta.raw, "-filter_complex", filter, "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(output, `${clip}.mp4`)]);
  run(["-i", join(input, `${shot}.png`), "-frames:v", "1", "-c:v", "libwebp", "-quality", "92", join(output, `${shot}.webp`)]);
  copyFileSync(join(output, `${shot}.webp`), join(output, `${clip}-poster.webp`));
  let elapsed = 0;
  const captions = [];
  for (const segment of segments) {
    for (const [i, mark] of meta.marks.entries()) {
      const start = Math.max(mark.at, segment.start);
      const end = Math.min(meta.marks[i + 1]?.at ?? meta.end, segment.end);
      if (end > start) {
        const cue = { start: elapsed + start - segment.start, end: elapsed + end - segment.start, text: mark.text };
        const previous = captions.at(-1);
        if (previous && previous.text === cue.text && Math.abs(previous.end - cue.start) < .01) previous.end = cue.end;
        else captions.push(cue);
      }
    }
    elapsed += segment.end - segment.start;
  }
  const cues = captions.map((cue, i) => `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`).join("\n");
  writeFileSync(join(output, `${clip}.vtt`), `WEBVTT\n\n${cues}`);
  console.log(`Encoded ${clip} (${elapsed.toFixed(1)}s)`);
}
copyFileSync(join(input, "workflow-proof.png"), join(output, "demo-poster.png"));
// The README leads with the same core workflow as the website.
copyFileSync(join(output, "workflow.mp4"), join(output, "demo.mp4"));
run(["-i", join(output, "demo.mp4"), "-filter_complex", "fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3", "-loop", "0", join(output, "demo.gif")]);
