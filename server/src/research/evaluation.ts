import { z } from "zod";
import { assessEvidence } from "./evidence.js";
import {
  digest,
  modelCall,
  now,
  readStore,
  saveStore,
  type ModelCall,
} from "./store.js";
import { loadSettings } from "../settings.js";
import { activeBackendId } from "../agent.js";
const verdict = z.enum([
  "supported",
  "partially_supported",
  "not_supported",
  "unclear",
]);
export const evaluationCaseSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(100),
  title: z.string().min(1).max(500),
  url: z.url().max(2000).refine(url => /^https?:\/\//i.test(url), "Source URL must use HTTP or HTTPS"),
  location: z.string().min(1).max(500),
  excerpt: z.string().min(8).max(40000),
  claim: z.string().min(8).max(4000),
  expected: verdict,
  rationale: z.string().min(10).max(4000),
  category: z.string().min(1).max(100),
});
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;
// Short attributed quotations; proposed labels require a user's independent review.
const sources = [
  {
    title: "Attention Is All You Need",
    url: "https://arxiv.org/abs/1706.03762v7",
    excerpt:
      "Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task",
    score: "28.4 BLEU",
    wrong: "38.4 BLEU",
    dataset: "WMT 2014 English-to-German",
    other: "English-to-French",
    category: "translation",
  },
  {
    title:
      "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
    url: "https://arxiv.org/abs/1810.04805v2",
    excerpt: "MultiNLI accuracy to 86.7% (4.6% absolute improvement)",
    score: "86.7% accuracy",
    wrong: "96.7% accuracy",
    dataset: "MultiNLI",
    other: "SQuAD",
    category: "language",
  },
  {
    title: "Deep Residual Learning for Image Recognition",
    url: "https://arxiv.org/abs/1512.03385v1",
    excerpt:
      "An ensemble of these residual nets achieves 3.57% error on the ImageNet test set.",
    score: "3.57% error",
    wrong: "0.57% error",
    dataset: "the ImageNet test set",
    other: "CIFAR-10",
    category: "vision",
  },
];
export const starterCases: EvaluationCase[] = sources.flatMap((s, i) =>
  [
    {
      claim: `The reported ${i === 2 ? "ensemble" : "model"} result on ${s.dataset} is ${s.score}.`,
      expected: "supported",
      category: "matching-evidence",
      rationale:
        "The reported value, evaluation setting and model/ensemble qualifier agree with the excerpt.",
    },
    {
      claim: `The same reported result on ${s.dataset} is ${s.wrong}.`,
      expected: "not_supported",
      category: "wrong-number",
      rationale:
        "The claim changes the numeric value for the same reported evaluation result.",
    },
    {
      claim: `The method obtains ${s.score} on ${s.other}.`,
      expected: "unclear",
      category: "different-dataset",
      rationale:
        "The excerpt concerns a different evaluation setting and does not settle this claim.",
    },
    {
      claim: `The reported result on ${s.dataset} is ${s.score}, and this method is optimal for every possible dataset.`,
      expected: "partially_supported",
      category: "partial-evidence",
      rationale:
        "The numeric result is supported, but the added universal claim has no basis in the supplied excerpt.",
    },
    {
      claim:
        "The method is always the best choice for every dataset and training budget.",
      expected: "unclear",
      category: "overgeneralization",
      rationale:
        "One reported result cannot establish universal superiority; missing evidence is not a demonstrated contradiction.",
    },
  ].map((c, n) => ({
    id: `starter-${i + 1}-${n + 1}`,
    title: s.title,
    url: s.url,
    excerpt: s.excerpt,
    location:
      "Abstract excerpt (verified 2026-09-14); quote page 1 refers to this excerpt, not a PDF page.",
    ...c,
    expected: c.expected as EvaluationCase["expected"],
  })),
);
interface Review {
  hash: string;
  expected: EvaluationCase["expected"];
  reason: string;
  at: string;
}
interface Result {
  caseId: string;
  caseHash: string;
  at: string;
  backend: string;
  model: string;
  verdict: EvaluationCase["expected"];
  explanation: string;
  quotes: { page: number; quote: string }[];
}
export const evaluationCases = (id: string) =>
  readStore<EvaluationCase[]>(id, "evaluation-cases", starterCases);
export function reviewEvaluationCase(
  id: string,
  input: {
    id: string;
    hash: string;
    expected: EvaluationCase["expected"];
    reason: string;
  },
) {
  const item = evaluationCases(id).find((c) => c.id === input.id);
  if (!item || digest(item) !== input.hash)
    throw new Error("Evaluation case changed. Review it again.");
  const review: Review = {
    hash: input.hash,
    expected: verdict.parse(input.expected),
    reason: z.string().trim().min(12).max(4000).parse(input.reason),
    at: now(),
  };
  saveStore(id, "evaluation-reviews", {
    ...readStore(id, "evaluation-reviews", {}),
    [item.id]: review,
  });
  return evaluationReport(id);
}
export function importEvaluationCases(id: string, input: unknown) {
  const cases = z.array(evaluationCaseSchema).min(1).max(500).parse(input);
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error("Duplicate evaluation case IDs");
  saveStore(id, "evaluation-cases", cases);
  return evaluationReport(id);
}
export async function evaluateCase(
  id: string,
  key: string,
  call: ModelCall = modelCall,
) {
  const item = evaluationCases(id).find((c) => c.id === key);
  if (!item) throw new Error("Unknown evaluation case");
  const settings = loadSettings();
  const backend = activeBackendId(settings);
  const model =
    backend === "codex"
      ? settings.codexModel
      : backend === "openai"
        ? settings.openaiModel
        : settings.model;
  // Expected labels and reviewer notes are deliberately excluded from the judge input.
  const { result } = await assessEvidence(
    item.claim,
    {
      key: item.id,
      title: item.title,
      basis: "abstract",
      pages: [item.excerpt],
      source: item.url,
      limitations: [item.location],
    },
    call,
  );
  const record: Result = {
    caseId: item.id,
    caseHash: digest(item),
    at: now(),
    backend,
    model,
    ...result,
  };
  saveStore(
    id,
    "evaluation-results",
    [...readStore<Result[]>(id, "evaluation-results", []), record].slice(
      -10000,
    ),
  );
  return record;
}
export function evaluationReport(id: string) {
  const reviews = readStore<Record<string, Review>>(
    id,
    "evaluation-reviews",
    {},
  );
  const cases = evaluationCases(id).map((c) => ({
    ...c,
    hash: digest(c),
    review: reviews[c.id]?.hash === digest(c) ? reviews[c.id] : undefined,
  }));
  const results = readStore<Result[]>(id, "evaluation-results", []).filter(
    (r) => cases.some((c) => c.id === r.caseId && c.hash === r.caseHash),
  );
  const groups = [
    ...new Set(results.map((r) => `${r.backend}/${r.model}`)),
  ].map((name) => {
    const latest = [
      ...new Map(
        results
          .filter((r) => `${r.backend}/${r.model}` === name)
          .map((r) => [r.caseId, r]),
      ).values(),
    ];
    const scored = latest.flatMap((r) => {
      const c = cases.find((c) => c.id === r.caseId)!;
      return c.review ? [{ ...r, expected: c.review.expected }] : [];
    });
    const correct = scored.filter((r) => r.verdict === r.expected).length;
    const negative = scored.filter((r) => r.expected !== "supported");
    return {
      name,
      evaluated: latest.length,
      reviewed: scored.length,
      correct,
      accuracy: scored.length ? correct / scored.length : null,
      falseSupportRate: negative.length
        ? negative.filter((r) => r.verdict === "supported").length /
          negative.length
        : null,
      results: latest,
      confusion: scored.reduce<Record<string, number>>(
        (m, r) => ({
          ...m,
          [`${r.expected} → ${r.verdict}`]:
            (m[`${r.expected} → ${r.verdict}`] ?? 0) + 1,
        }),
        {},
      ),
    };
  });
  return {
    cases,
    groups,
    reviewed: cases.filter((c) => c.review).length,
    note: "Starter cases use short excerpts from three real papers. Their labels are proposals until you review them. Scores include only reviewed, unchanged cases, grouped by configured backend/model. This small calibration set does not establish general scientific reliability. Import an independently annotated dataset for a meaningful benchmark.",
  };
}
