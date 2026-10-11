import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { SiteNav, SiteFooter } from "@/components/site";
import { getSession } from "@/lib/session";
import { createWorkflow } from "@/app/workflow-actions";

export const metadata = { title: "Workflows — AbetFlow" };
export const dynamic = "force-dynamic";

/**
 * The workflow list. Everything a person needs to start is here: what exists,
 * what runs on what trigger, and one button to make the next one. A product
 * whose objects can only be created over HTTP is an API with a brochure; this
 * page is the other half.
 */
export default async function WorkflowsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const workflows = await prisma.workflow.findMany({
    where: { workspaceId: session.workspaceId },
    include: { _count: { select: { executions: true, versions: true } } },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Abetworks</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-cyan-600">Workflows</h1>
        <p className="mt-2 text-sm text-gray-600">
          {workflows.length === 0
            ? "Nothing yet. Make the first one — a trigger, a step or two, and a run to prove it."
            : `${workflows.length} workflow${workflows.length === 1 ? "" : "s"} in this workspace.`}
        </p>

        <form action={createWorkflow} className="mt-6 flex max-w-md gap-2">
          <input
            name="name"
            placeholder="e.g. Deal triage"
            required
            className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-gray-500 focus:outline-none"
          />
          <button
            type="submit"
            className="shrink-0 rounded-md bg-cyan-600 px-4 py-2 text-[12px] font-semibold text-white hover:bg-cyan-700"
          >
            New workflow
          </button>
        </form>

        <div className="mt-8 space-y-3">
          {workflows.map((w) => {
            const trigger = (w.trigger ?? {}) as { kind?: string; path?: string; cron?: string };
            return (
              <Link
                key={w.id}
                href={`/workflows/${w.id}`}
                className="block rounded-2xl border border-gray-200 bg-white p-5 shadow-sm transition hover:border-gray-300"
              >
                <div className="flex items-center gap-3">
                  <h2 className="font-semibold text-gray-900">{w.name}</h2>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                      w.status === "ACTIVE" ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {w.status}
                  </span>
                  <span className="rounded-full bg-gray-100 px-2.5 py-0.5 font-mono text-[11px] text-gray-600">
                    {trigger.kind ?? "manual"}
                  </span>
                  <span className="ml-auto text-[12px] text-gray-500">
                    {w._count.executions} run{w._count.executions === 1 ? "" : "s"} · {w._count.versions} version
                    {w._count.versions === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[12px] text-gray-500">
                  {trigger.kind === "webhook" && trigger.path
                    ? `POST ${trigger.path}`
                    : trigger.kind === "cron" && trigger.cron
                      ? trigger.cron
                      : "runs from the editor"}
                </p>
              </Link>
            );
          })}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
