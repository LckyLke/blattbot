/**
 * Environment diagnostic: report the platform, TeX engine, git/Claude CLI
 * status, and every browser cookie store BlattBot can see.
 * Run: npx tsx server/scripts/doctor.ts   (or `blattbot doctor` when installed)
 */
import { runDoctor } from "../src/doctor.js";

await runDoctor();
