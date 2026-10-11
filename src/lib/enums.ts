/**
 * The word-lists this schema only *describes*. SQLite has no enum type, so
 * `Workflow.status String @default("DRAFT") // DRAFT | ACTIVE | PAUSED | ARCHIVED`
 * is a comment: Prisma will insert anything, and the value is read back as a
 * plain String by every `status !== "ACTIVE"` guard and `status` filter.
 *
 * These sets are copied from those comments and from `llm-node.ts`, which is the
 * only place the task words are used. If a comment and this file ever disagree,
 * this file is what the boundary enforces, so the disagreement shows up as a
 * refused write rather than as a row the app cannot see.
 */

export const WORKFLOW_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"] as const;

export const LLM_TASKS = ["classify", "extract", "summarize", "transform"] as const;
