import { completeJson } from "./llm";

/**
 * The `llm` workflow node: classify, extract, summarize, or transform.
 *
 * This node behaves differently from every other AI feature in the portfolio,
 * and the difference is the whole design. In LeadGenius, LeadWorks and
 * AbetAnalytics a human reviews the output, so a missing model can degrade to
 * "no suggestion". **A workflow run has no human in the loop** — the next node
 * fires on whatever this one returns. So this node never guesses and never
 * falls back: if no model is configured, or the provider is down, or the model
 * answers something unusable, it *throws* and lets the run's existing
 * `onError` / `continueOnFail` wiring decide what happens. The workflow author
 * chose that fallback deliberately; a silent plausible-looking guess would
 * quietly take that decision away from them.
 *
 * Two further constraints keep this from becoming an expensive or unsafe
 * escape hatch:
 *   - `classify` is a closed set. The model picks from labels the author
 *     listed, and a label it invents is rejected rather than passed downstream.
 *   - Input is truncated to `maxChars` (default 8000) before it leaves the
 *     server, and credentials are never passed as context.
 */

export type LlmTask = "classify" | "extract" | "summarize" | "transform";

export interface LlmNodeConfig {
  task?: string;
  prompt?: string;
  /** Required for classify: the only answers the model may return. */
  labels?: unknown;
  /** Required for extract: the keys to pull out. */
  fields?: unknown;
  model?: string;
  temperature?: number;
  maxChars?: unknown;
}

export interface LlmNodeInput {
  /** Already template-rendered prompt from the executor. */
  prompt: string;
  input: unknown;
  config: LlmNodeConfig;
  llmComplete?: LlmCompleteFn;
}

/** Injection seam — tests pass a stub, production uses the real client. */
export type LlmCompleteFn = (
  system: string,
  user: string,
  options: { schemaHint?: string; temperature?: number; maxTokens?: number; model?: string },
) => Promise<{ data: unknown; usage: { totalTokens: number } } | null>;

const DEFAULT_MAX_CHARS = 8000;

const SYSTEMS: Record<LlmTask, string> = {
  classify:
    "You label text with exactly one label from a fixed list. You never invent a label and never combine labels. Respond with JSON only.",
  extract:
    "You extract named fields from text. You copy values verbatim from the text and never infer or fabricate a value. If a field is absent, return null for it. Respond with JSON only.",
  summarize:
    "You summarise text faithfully and concisely. You never introduce facts that are not in the text. Respond with JSON only.",
  transform:
    "You rewrite input according to instructions, following them exactly and adding nothing. Respond with JSON only.",
};

export function readTask(raw: unknown): LlmTask {
  const t = String(raw ?? "").toLowerCase();
  return (["classify", "extract", "summarize", "transform"] as const).includes(t as LlmTask)
    ? (t as LlmTask)
    : "summarize";
}

function readStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}

/** Keep the payload bounded so a large body cannot become a large bill. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

export async function runLlmNode(node: LlmNodeInput): Promise<unknown> {
  const task = readTask(node.config.task);
  const prompt = node.prompt.trim();
  if (!prompt) throw new Error("llm node needs a non-empty prompt");

  const maxChars = Math.max(100, Math.min(50_000, Number(node.config.maxChars) || DEFAULT_MAX_CHARS));
  const labels = readStringList(node.config.labels);
  const fields = readStringList(node.config.fields);

  if (task === "classify" && labels.length < 2) {
    throw new Error("llm classify needs at least two labels to choose between");
  }
  if (task === "extract" && fields.length === 0) {
    throw new Error("llm extract needs a non-empty fields[] list");
  }

  const system = SYSTEMS[task];
  const user = [
    "Text to work on:",
    "---",
    truncate(typeof node.input === "string" ? node.input : JSON.stringify(node.input ?? null), maxChars),
    "---",
    "Instructions:",
    prompt,
  ].join("\n");

  const complete = node.llmComplete ?? (completeJson as unknown as LlmCompleteFn);
  const options: Parameters<LlmCompleteFn>[2] = {
    temperature: typeof node.config.temperature === "number" ? node.config.temperature : 0,
    maxTokens: 800,
    model: typeof node.config.model === "string" ? node.config.model : undefined,
  };

  if (task === "classify") {
    const res = await complete(
      system,
      `${user}\n\nChoose exactly one of: ${labels.map((l) => JSON.stringify(l)).join(", ")}`,
      {
        ...options,
        temperature: 0,
        schemaHint: `{ "label": string, "confidence": number } — label must be one of ${JSON.stringify(labels)}`,
      },
    );
    const label = res && typeof (res.data as { label?: unknown })?.label === "string"
      ? ((res.data as { label: string }).label).trim()
      : "";
    // A label outside the author's list is treated as a failure, not a new class.
    if (!label || !labels.some((l) => l.toLowerCase() === label.toLowerCase())) {
      throw new Error(`llm classify returned ${label ? `'${label}'` : "nothing"} which is not one of the configured labels`);
    }
    const match = labels.find((l) => l.toLowerCase() === label.toLowerCase()) as string;
    const confidence = (res?.data as { confidence?: unknown })?.confidence;
    return {
      label: match,
      confidence: typeof confidence === "number" ? Math.max(0, Math.min(1, confidence)) : null,
      usage: res?.usage ?? null,
    };
  }

  if (task === "extract") {
    const res = await complete(
      system,
      user,
      {
        ...options,
        temperature: 0,
        schemaHint: `{ ${fields.map((f) => `"${f.replace(/"/g, "")}": string | null`).join(", ")} }`,
      },
    );
    if (!res || typeof res.data !== "object" || res.data === null) {
      throw new Error("llm extract returned no object");
    }
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = (res.data as Record<string, unknown>)[f];
      out[f] = typeof v === "string" ? v : v === null || v === undefined ? null : v;
    }
    return { ...out, usage: res.usage ?? null };
  }

  const res = await complete(system, user, {
    ...options,
    schemaHint: '{ "result": string }',
  });
  if (!res) throw new Error(`llm ${task} returned no result`);
  const result = typeof (res.data as { result?: unknown })?.result === "string"
    ? (res.data as { result: string }).result.trim()
    : "";
  if (!result) throw new Error(`llm ${task} returned no result`);
  return { result, usage: res.usage ?? null };
}
