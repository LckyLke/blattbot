import { z } from "zod";
import { now, readStore, saveStore } from "./store.js";

export const memoryFields = [
  "question",
  "contribution",
  "definitions",
  "notation",
  "methods",
  "decisions",
  "openQuestions",
] as const;
const field = z.string().max(8000);
export const memorySchema = z.object({
  question: field,
  contribution: field,
  definitions: field,
  notation: field,
  methods: field,
  decisions: field,
  openQuestions: field,
});
export type MemoryFields = z.infer<typeof memorySchema>;
const empty: MemoryFields = {
  question: "",
  contribution: "",
  definitions: "",
  notation: "",
  methods: "",
  decisions: "",
  openQuestions: "",
};
export interface MemoryVersion {
  revision: number;
  at: string;
  fields: MemoryFields;
}
export interface ProjectMemory extends MemoryVersion {
  history: MemoryVersion[];
  proposal?: {
    fields: MemoryFields;
    reason: string;
    at: string;
    baseRevision: number;
  };
}
export function readMemory(id: string): ProjectMemory {
  return readStore(id, "memory", {
    revision: 0,
    at: "",
    fields: { ...empty },
    history: [],
  });
}
export function saveMemory(
  id: string,
  fields: MemoryFields,
  revision: number,
): ProjectMemory {
  fields = memorySchema.parse(fields);
  const previous = readMemory(id);
  if (previous.revision !== revision)
    throw new Error("Project memory changed elsewhere. Reload before saving.");
  return saveStore(id, "memory", {
    fields,
    revision: revision + 1,
    at: now(),
    history: [
      ...previous.history,
      { revision: previous.revision, at: previous.at, fields: previous.fields },
    ].slice(-50),
  });
}
export function proposeMemory(
  id: string,
  fields: MemoryFields,
  reason: string,
): ProjectMemory {
  const previous = readMemory(id);
  return saveStore(id, "memory", {
    ...previous,
    proposal: {
      fields: memorySchema.parse(fields),
      reason: z.string().min(1).max(2000).parse(reason),
      at: now(),
      baseRevision: previous.revision,
    },
  });
}
export function memoryPrompt(id: string): string {
  const memory = readMemory(id);
  if (!memory.revision) return "";
  return `\n\nUser-approved project memory (revision ${memory.revision}). Use this for continuity; verify factual claims against sources. Proposed changes require the user's approval in Research → Memory.\n${JSON.stringify(memory.fields)}`;
}
