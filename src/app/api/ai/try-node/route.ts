import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { resolveAiActor, withAiAuth } from "@/lib/ai-actor";
import { isLlmConfigured } from "@/lib/llm";
import { runLlmNode } from "@/lib/llm-node";
import { readJson, validateBody } from "@/lib/validate";
import { LLM_TRY_NODE } from "@/lib/fields";

export const dynamic = "force-dynamic";

/**
 * POST /api/ai/try-node — run one `llm` node outside a workflow.
 *
 * The node is reachable by saving a workflow, but that is a slow way to find out
 * whether "classify this support ticket" is worth using. This runs the exact
 * same code path against text you paste, so the node can be evaluated before it
 * is wired into anything.
 *
 * Note what is *not* here: a fallback. The node throws when the provider is
 * unreachable or answers something unusable, and that error is returned as an
 * error. That is deliberate and identical to a real run — the playground must not
 * be more forgiving than the workflow, or it will happily show a result the
 * workflow could never produce.
 *
 * The table on the body is the same rule in a different place: the playground must
 * not be more forgiving about *input* than the node is either. `text: 42` and
 * `text: "   "` were both refused as "Paste some text to work on." — a wrong type
 * answered as a missing field — and are now 400s naming `text`
 * (`n5-af-before.mts`). What the other two fields were doing is read from
 * `llm-node.ts`, because the probe server had no `LLM_API_KEY` and answered
 * `{configured: false}` before the node ran: `task: 42` would have reached
 * `readTask`, whose fallback is summarize, showing a caller who asked for
 * `classify` the answer of a different node; `labels: "a,b"` would have reached
 * `readStringList`, which reads a non-array as no labels at all.
 */
async function POST_impl(request: Request) {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.error;
  const { body } = parsed;

  // The claim is handed to the vendored module and to nothing else. This app's
  // own `authedWorkspaceId` gates it on truthiness, which read `0` and `false` as
  // "nothing was claimed" and ran the playground in the key's workspace for a
  // caller who had put another one in the body
  // (`/tmp/abectorial/n25-abetflow-before.txt`).
  await resolveAiActor(request, {
    claimedWorkspaceId: body.workspaceId,
    keyWorkspaceId: () => authedWorkspaceId(request),
  });

  const input = validateBody(body, LLM_TRY_NODE);
  if (!input.ok) return input.error;
  const { text, task, labels, fields, model } = input.data;

  if (!isLlmConfigured()) {
    return NextResponse.json({
      configured: false,
      reason: "No LLM_API_KEY set — set one to try this node.",
    });
  }

  try {
    const out = await runLlmNode({
      prompt: playgroundPrompt(task),
      input: text,
      config: {
        task,
        // The defaults are the node's own examples, kept here so that omitting the
        // list still shows what a classify/extract node would do with one.
        labels: task === "classify" ? (labels ?? ["question", "bug", "billing", "other"]) : undefined,
        fields: task === "extract" ? (fields ?? ["summary", "sentiment"]) : undefined,
        model,
      },
    });
    return NextResponse.json({ ok: true, result: out, note: "Nothing was saved and no workflow ran." });
  } catch (error) {
    // Surfaced verbatim: this is what a real run would do, including failing.
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "The node failed." },
      { status: 502 },
    );
  }
}

/** Written per task so the playground demonstrates each one honestly. */
function playgroundPrompt(task?: string): string {
  switch ((task ?? "summarize").toLowerCase()) {
    case "classify":
      return "Label this message with the single best label.";
    case "extract":
      return "Pull out the requested fields, copying values verbatim. Use null when absent.";
    case "transform":
      return "Rewrite this as a single clear sentence.";
    default:
      return "Summarise this in two sentences, using only what is written.";
  }
}

export const POST = withAuth(withAiAuth(POST_impl));
