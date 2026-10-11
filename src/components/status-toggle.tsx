"use client";

import { useActionState } from "react";
import { setWorkflowStatus } from "@/app/workflow-actions";

/**
 * Activate/Pause toggle.
 *
 * A client component because activation can be refused — an empty workflow, or
 * a saved definition that no longer validates — and that refusal has to be
 * shown where the button is rather than swallowed by a redirect. A bare form
 * action cannot return state, so this wraps it.
 */
export function StatusToggle({ workflowId, status }: { workflowId: string; status: string }) {
  const [state, action] = useActionState(setWorkflowStatus, {});
  const active = status === "ACTIVE";

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={workflowId} />
      {active ? (
        <button
          type="submit"
          name="status"
          value="DRAFT"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-[12px] font-semibold text-gray-700 hover:bg-gray-50"
        >
          Pause
        </button>
      ) : (
        <button
          type="submit"
          name="status"
          value="ACTIVE"
          className="rounded-md bg-green-700 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-green-800"
        >
          Activate
        </button>
      )}
      {state.error && (
        <span role="alert" className="text-[12px] text-red-700">
          {state.error}
        </span>
      )}
    </form>
  );
}
