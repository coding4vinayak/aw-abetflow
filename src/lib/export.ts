import { prisma } from "./db";
import { asRecord } from "./json";

/**
 * The export surface for a workflow automation workspace.
 *
 * Two doors:
 *
 *   - `buildWorkspaceExport` is the portable copy: team, invitations, workflows
 *     with their version history, variables, webhook destinations, and credential
 *     names (never the encrypted values).
 *   - `executionCsvHeader` / `executionCsvRow` are the audit trail: one row per
 *     execution with its complete step trace in `steps_json`, streamed in
 *     batches so a high-volume workspace never has to fit in memory.
 *
 * Content, not credentials. The rows a buyer owns are workflows, executions,
 * steps, variables, webhook destinations and credential names. Password digests,
 * session tokens, API-key hashes, invitation token hashes, webhook signing
 * secrets, credential ciphertext/IV and Stripe ids are not exported. A
 * credential row keeps its name and provider but drops `ciphertext` and `iv`.
 * A webhook row keeps its destination/event list but drops its signing key.
 *
 * Every query is scoped by workspaceId. A bug in the caller cannot turn one
 * buyer's export into another's.
 */
export const EXPORT_FORMAT = "abetflow.workspace";
export const EXPORT_VERSION = 1;

/** Collapse a slug to a filename-safe token, then fail closed to "workspace". */
function safeSlug(slug: string): string {
  return (
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace"
  );
}

/** The download filename, pure so the header path is testable without a database. */
export function exportFilename(
  slug: string,
  part: "workspace" | "executions",
  at: Date = new Date(),
): string {
  const extension = part === "workspace" ? "json" : "csv";
  return `abetflow-${safeSlug(slug)}-${part}-${at.toISOString().slice(0, 10)}.${extension}`;
}

/** Every export shares these headers; `no-store` keeps a proxy from retaining a copy. */
export function exportDownloadHeaders(filename: string, contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

/** Drop a credential's encrypted payload while keeping the rest. */
export function publicCredential(cred: { id: string; name: string; provider: string; createdAt: Date; updatedAt: Date; ciphertext: string; iv: string }): Record<string, unknown> {
  const { ciphertext, iv, ...rest } = cred;
  return rest;
}

/** Drop a webhook's signing secret while keeping the rest. */
export function publicWebhook(hook: { id: string; url: string; events: string; isActive: boolean; createdAt: Date; updatedAt: Date }): Record<string, unknown> {
  return hook;
}

export async function buildWorkspaceExport(workspaceId: string, exportedAt: Date = new Date()) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true },
  });
  if (!workspace) throw new Error("Workspace not found");

  const [members, invitations, workflows, executions, variables, webhooks, credentials] =
    await Promise.all([
      prisma.membership.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          userId: true,
          role: true,
          createdAt: true,
          user: { select: { email: true, name: true, emailVerified: true } },
        },
      }),
      prisma.invite.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          email: true,
          role: true,
          createdById: true,
          createdAt: true,
          expiresAt: true,
          acceptedAt: true,
        },
      }),
      prisma.workflow.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          trigger: true,
          definition: true,
          status: true,
          nextRunAt: true,
          createdAt: true,
          updatedAt: true,
          versions: {
            orderBy: { version: "asc" },
            select: {
              version: true,
              trigger: true,
              definition: true,
              note: true,
              createdAt: true,
            },
          },
        },
      }),
      prisma.execution.count({ where: { workspaceId } }),
      prisma.variable.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, value: true, createdAt: true, updatedAt: true },
      }),
      prisma.webhook.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        // The signing secret is a credential. The destination and event list
        // are configuration the buyer can recognize in a new home.
        select: {
          id: true,
          url: true,
          events: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.credential.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        // ciphertext and iv are deliberately absent: they are the encrypted
        // payload, not content the buyer needs to take with them.
        select: {
          id: true,
          name: true,
          provider: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    workspace,
    counts: {
      members: members.length,
      invitations: invitations.length,
      workflows: workflows.length,
      executions,
      variables: variables.length,
      webhooks: webhooks.length,
      credentials: credentials.length,
    },
    notes: [
      "Credentials are excluded: password digests, session tokens, API keys and their hashes, invitation token hashes, webhook signing secrets, credential ciphertext/IV, and Stripe billing ids.",
      "Execution traces are not embedded in this document. Download them from GET /api/export/executions, which streams one row per execution with its complete step trace.",
    ],
    executions: {
      count: executions,
      download: "/api/export/executions",
      contentType: "text/csv; charset=utf-8",
    },
    members,
    invitations,
    workflows,
    variables,
    webhooks: webhooks.map(publicWebhook),
    credentials,
  };
}

export type WorkspaceExport = Awaited<ReturnType<typeof buildWorkspaceExport>>;

/* --------------------------------------------------------------------- execution audit */

export interface ExecutionStepCsv {
  position: number;
  nodeId: string;
  nodeType: string;
  status: string;
  output: unknown;
  error: string | null;
  durationMs: number | null;
  createdAt: Date | string;
}

export interface ExecutionCsvRow {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  source: string;
  input: unknown;
  output: unknown;
  error: string | null;
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  steps: ExecutionStepCsv[];
}

/**
 * A text cell that cannot become a spreadsheet formula. Execution input/output
 * and workflow names are user text; a leading `=`, `+`, `-`, `@`, tab or CR is
 * the CSV injection shape, so it gets an apostrophe. Numbers never pass here.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function textCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function iso(value: Date | string | null): string {
  if (value === null) return "";
  return value instanceof Date ? value.toISOString() : value;
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

const EXECUTION_HEADER = [
  "execution_id",
  "workflow_id",
  "workflow_name",
  "status",
  "source",
  "input",
  "output",
  "error",
  "created_at",
  "started_at",
  "completed_at",
  "steps_json",
];

export function executionCsvHeader(): string {
  return `${EXECUTION_HEADER.map(textCell).join(",")}\r\n`;
}

/**
 * One execution per line. `steps_json` preserves the ordered trace (position,
 * nodeId, nodeType, status, output, error, durationMs, createdAt) rather than
 * flattening it into repeated execution rows, so a reader can both scan the
 * execution list and replay what each step did.
 */
export function executionCsvRow(row: ExecutionCsvRow): string {
  return (
    [
      textCell(row.id),
      textCell(row.workflowId),
      textCell(row.workflowName),
      textCell(row.status),
      textCell(row.source),
      textCell(jsonText(row.input)),
      textCell(jsonText(row.output)),
      textCell(row.error),
      textCell(iso(row.createdAt)),
      textCell(iso(row.startedAt)),
      textCell(iso(row.completedAt)),
      textCell(jsonText(row.steps)),
    ].join(",") + "\r\n"
  );
}