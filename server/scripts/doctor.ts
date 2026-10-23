/**
 * Environment diagnostic: report the platform, Node, required tools (git),
 * optional ones (TeX, Codex, Poppler, Tesseract, ...), and every browser
 * cookie store BlattBot can see. Exits 1 when a required tool is missing.
 * Run: npx tsx server/scripts/doctor.ts   (or `blattbot doctor` when installed)
 */
import { runDoctor } from "../src/doctor.js";

const { failures } = await runDoctor();
process.exitCode = failures.length > 0 ? 1 : 0;
