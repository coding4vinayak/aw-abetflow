"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * The example-workflow panel: one flow that has already run, and the one
 * click that takes it away again.
 *
 * It talks to `/api/example-workflow` over the session (the browser never
 * holds an API key) and then asks the server to re-render, so the run on the
 * screen is the one the engine produced — not a number this component
 * invented.
 */
export function ExampleWorkflowCard({ loaded }: { loaded: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function call(method: "POST" | "DELETE") {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/example-workflow", { method });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || "Could not reach the server.");
          return;
        }
        router.refresh();
      } catch {
        setError("Network error — try again.");
      }
    });
  }

  if (loaded) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <p className="text-sm font-semibold text-amber-900">
          The example workflow is loaded — it is a sample flow, not your own.
        </p>
        <p className="mt-1 text-xs text-amber-800">
          One workflow that reads a lead and routes it by size, run once so you can see the real
          step trace. Open it, edit it, or remove it — one click takes it and its run away, and
          nothing of yours is touched.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => call("DELETE")}
            disabled={pending}
            className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
          >
            {pending ? "Working…" : "Remove the example workflow"}
          </button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5">
      <p className="text-sm font-semibold text-gray-900">See it run — one click, no setup.</p>
      <p className="mt-1 text-xs text-gray-600">
        Loads one example workflow: a lead arrives, is read, and is routed by size. It runs
        immediately, so you get the real step trace — every node, what it saw, and what it
        produced. It is example data, it is labelled as such, and one click removes it again.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => call("POST")}
          disabled={pending}
          className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-cyan-700 disabled:opacity-50"
        >
          {pending ? "Loading…" : "Load the example workflow"}
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}
