import { VERSION } from "./version";

/**
 * The API contract — what an integrator reads, and what the acceptance
 * sweep checks against the routes.
 *
 * AbetFlow is the suite's plumbing and it sells on its API: an inbound
 * webhook starts a run, steps call your endpoints, and every completed run
 * publishes a signed webhook. A contract is a second description of that
 * machine, and second descriptions rot. This one cannot: `scripts/check-contract.mts`
 * reads every claim back out of the source that serves it. Every route that
 * answers is in here and every operation here has a route that answers; every
 * request body is compared with the app's own declared field table, so the
 * spec cannot advertise a field the door would refuse; and the version is
 * the app's version, read from the same place the landing page's badge reads
 * it.
 */
const API_KEY = [{ apiKey: [] }];
const SESSION = [{ sessionCookie: [] }];
const SESSION_OR_KEY = [{ sessionCookie: [] }, { apiKey: [] }];
const NONE: Record<string, string[]>[] = [];

type Method = "get" | "post" | "patch" | "put" | "delete";

interface Operation {
  /** A stable name for the call — the operationId an SDK would generate. */
  id: string;
  /** One line, said the way the README says it. */
  summary: string;
  /** The auth the route enforces. */
  auth?: "key" | "session" | "session-or-key" | "none";
  /** Query parameters, as `[name, description]`. */
  query?: [string, string][];
  /** Path parameters, as `[name, description]` — always required, as the template is. */
  pathParams?: [string, string][];
  /** A JSON body, described as its properties. */
  body?: { description: string; properties: Record<string, { type: string; description: string; required?: boolean }> };
  /** The statuses the route can answer, with what each one carries. */
  responses?: Record<string, string>;
  /** The field table the body is checked against, by name. */
  fields?: string;
}

interface PathItem {
  get?: Operation;
  post?: Operation;
  patch?: Operation;
  put?: Operation;
  delete?: Operation;
}

const securityFor = (auth: Operation["auth"]) =>
  auth === "key" ? API_KEY : auth === "session" ? SESSION : auth === "session-or-key" ? SESSION_OR_KEY : NONE;

function op(method: Method, operation: Operation): Record<string, unknown> {
  const parameters = [
    ...(operation.pathParams ?? []).map(([name, description]) => ({
      name,
      in: "path",
      required: true,
      description,
      schema: { type: "string" },
    })),
    ...(operation.query ?? []).map(([name, description]) => ({
      name,
      in: "query",
      required: false,
      description,
      schema: { type: "string" },
    })),
  ];
  const body = operation.body
    ? {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: Object.fromEntries(
                Object.entries(operation.body.properties).map(([name, shape]) => [
                  name,
                  { type: shape.type, description: shape.description },
                ]),
              ),
              required: Object.entries(operation.body.properties)
                .filter(([, shape]) => shape.required)
                .map(([name]) => name),
            },
          },
        },
      }
    : undefined;
  const responses = Object.fromEntries(
    Object.entries(operation.responses ?? { "200": "The answer." }).map(([status, description]) => [
      status,
      { description, content: { "application/json": { schema: { type: "object" } } } },
    ]),
  );
  return {
    operationId: operation.id,
    summary: operation.summary,
    tags: [operation.id.split(".")[0]],
    ...(parameters.length ? { parameters } : {}),
    ...(body ? { requestBody: body } : {}),
    responses,
    ...(operation.auth === "key" || operation.auth === "session" || operation.auth === "session-or-key"
      ? { security: securityFor(operation.auth) }
      : {}),
  };
}

const PATHS: Record<string, PathItem> = {
  "/api/health": {
    get: {
      id: "health.get",
      summary: "Liveness and a database ping. No key needed.",
      auth: "none",
      responses: { "200": "ok." },
    },
  },
  "/api/workflows": {
    get: {
      id: "workflows.list",
      summary: "The workspace's workflows, newest first.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["status", "One status, e.g. ACTIVE."],
        ["page", "1-based page number."],
        ["limit", "Page size; it caps at 100."],
      ],
      responses: { "200": "The workflows, with a total." },
    },
    post: {
      id: "workflows.create",
      fields: "WORKFLOW_CREATE",
      summary: "Create a workflow — nodes, and the trigger that starts it.",
      auth: "key",
      body: {
        description: "The name, the definition (the graph of steps), and the trigger.",
        properties: {
          name: { type: "string", description: "What the workflow is called.", required: true },
          description: { type: "string", description: "What it is for." },
          trigger: { type: "object", description: "A webhook needs path and secret (or public: true); a cron needs a real expression. Absent means manual." },
          definition: { type: "object", description: "The graph of steps — an empty graph is refused.", required: true },
          status: { type: "string", description: "ACTIVE, PAUSED or DRAFT." },
        },
      },
      responses: { "201": "The workflow, versioned." },
    },
  },
  "/api/workflows/{id}": {
    get: {
      id: "workflows.get",
      summary: "One workflow, at its current version.",
      auth: "key",
      responses: { "200": "The workflow." },
    },
    patch: {
      id: "workflows.update",
      fields: "WORKFLOW_PATCH",
      summary: "Edit a workflow — every omitted field is left alone, and the change is a new version.",
      auth: "key",
      body: {
        description: "The fields to change.",
        properties: {
          name: { type: "string", description: "A new name." },
          description: { type: "string", description: "What it is for." },
          trigger: { type: "object", description: "A new trigger." },
          definition: { type: "string", description: "A new graph of steps." },
          status: { type: "string", description: "ACTIVE, PAUSED or DRAFT." },
          note: { type: "string", description: "One caller line on the new version." },
        },
      },
      responses: { "200": "The workflow as it now reads." },
    },
    delete: {
      id: "workflows.delete",
      summary: "Delete a workflow and its runs.",
      auth: "key",
      responses: { "200": "The workflow is gone." },
    },
  },
  "/api/workflows/{id}/versions": {
    get: {
      id: "workflows.versions",
      summary: "A workflow's version history.",
      auth: "key",
      responses: { "200": "The versions, newest first." },
    },
    post: {
      id: "workflows.rollback",
      fields: "WORKFLOW_ROLLBACK",
      summary: "Roll a workflow back to an earlier version.",
      auth: "key",
      body: {
        description: "The version to roll back to.",
        properties: {
          version: { type: "number", description: "A whole number — 1.5 is refused at the door.", required: true },
        },
      },
      responses: { "200": "The rolled-back snapshot." },
    },
  },
  "/api/executions": {
    get: {
      id: "executions.list",
      summary: "The workspace's runs, newest first.",
      auth: "key",
      query: [
        ["workspaceId", "The workspace to read. Defaults to the key's own."],
        ["workflowId", "Only this workflow's runs."],
        ["page", "1-based page number."],
        ["limit", "Page size; it caps at 100."],
      ],
      responses: { "200": "The runs, with a total." },
    },
    post: {
      id: "executions.create",
      fields: "EXECUTION_CREATE",
      summary: "Start a run by hand — a webhook starts it too, but this is the door you call yourself.",
      auth: "key",
      body: {
        description: "The workflow and the input its nodes read as {{input.*}}.",
        properties: {
          workflowId: { type: "string", description: "The workflow to run.", required: true },
          input: { type: "object", description: "The run's payload — object or array." },
        },
      },
      responses: { "201": "The run, queued." },
    },
  },
  "/api/executions/{id}": {
    get: {
      id: "executions.get",
      summary: "One run: every step, what it touched, what it sent, what came back.",
      auth: "key",
      responses: { "200": "The run, with its steps." },
    },
    post: {
      id: "executions.retry",
      summary: "Retry a run that failed — ?action=retry.",
      auth: "key",
      query: [["action", "retry — the only action."]],
      responses: { "201": "The new run, queued from the failed one's input." },
    },
    delete: {
      id: "executions.delete",
      summary: "Forget a run.",
      auth: "key",
      responses: { "200": "The run is gone." },
    },
  },
  "/api/variables": {
    get: {
      id: "variables.list",
      summary: "The workspace's {{vars.*}} variables.",
      auth: "key",
      responses: { "200": "The variables." },
    },
    post: {
      id: "variables.put",
      fields: "VARIABLE_PUT",
      summary: "Set one variable — the name is the template word {{vars.name}}.",
      auth: "key",
      body: {
        description: "The name and the value.",
        properties: {
          name: { type: "string", description: "The template word — an identifier.", required: true },
          value: { type: "string", description: "Non-empty; delete the variable to make it empty.", required: true },
        },
      },
      responses: { "201": "The variable." },
    },
    delete: {
      id: "variables.delete",
      summary: "Remove a variable — ?name=…",
      auth: "key",
      query: [["name", "The variable to remove."]],
      responses: { "200": "The variable is gone." },
    },
  },
  "/api/credentials": {
    get: {
      id: "credentials.list",
      summary: "The workspace's stored credentials — sealed, never returned as plaintext.",
      auth: "key",
      responses: { "200": "The credentials, without their secrets." },
    },
    post: {
      id: "credentials.put",
      fields: "CREDENTIAL_PUT",
      summary: "Store a credential — it is encrypted at the door, and read back only inside a run.",
      auth: "key",
      body: {
        description: "The name, the connector, and the secret itself.",
        properties: {
          name: { type: "string", description: "What steps address it by.", required: true },
          provider: { type: "string", description: "A connector name, e.g. http or openai.", required: true },
          value: { type: "string", description: "The secret — sealed and never returned.", required: true },
        },
      },
      responses: { "201": "The credential, without its secret." },
    },
    delete: {
      id: "credentials.delete",
      summary: "Forget a credential — ?name=…",
      auth: "key",
      query: [["name", "The credential to remove."]],
      responses: { "200": "The credential is gone." },
    },
  },
  "/api/webhooks": {
    get: {
      id: "webhooks.list",
      summary: "The outbound subscriptions, with their signing secret previewed.",
      auth: "key",
      query: [["workspaceId", "The workspace to read. Defaults to the key's own."]],
      responses: { "200": "The subscriptions." },
    },
    post: {
      id: "webhooks.create",
      fields: "WEBHOOK_CREATE",
      summary: "Subscribe an address to events — each delivery is signed (x-webhook-signature, HMAC-SHA256).",
      auth: "key",
      body: {
        description: "Where to deliver, and which events.",
        properties: {
          url: { type: "string", description: "Where the deliveries go.", required: true },
          events: { type: "array", description: "The event names — an array or a comma string." },
        },
      },
      responses: { "201": "The subscription, with the signing secret returned once." },
    },
    patch: {
      id: "webhooks.update",
      fields: "WEBHOOK_PATCH",
      summary: "Edit a subscription — ?id=…",
      auth: "key",
      query: [["id", "The subscription to edit."]],
      body: {
        description: "The fields to change.",
        properties: {
          url: { type: "string", description: "A new address." },
          events: { type: "array", description: "A new set of event names." },
          isActive: { type: "boolean", description: "Whether it still delivers." },
        },
      },
      responses: { "200": "The subscription as it now reads." },
    },
    delete: {
      id: "webhooks.delete",
      summary: "Unsubscribe — ?id=…",
      auth: "key",
      query: [["id", "The subscription to remove."]],
      responses: { "200": "The subscription is gone." },
    },
  },
  "/api/webhooks/{path}": {
    get: {
      id: "webhooks.trigger",
      summary: "An inbound webhook trigger. The path is the trigger's path; a 401 means the secret in the payload did not match.",
      auth: "none",
      pathParams: [["path", "The trigger path the workflow was registered with."]],
      responses: { "202": "A run started.", "401": "Wrong secret.", "404": "No active workflow on this path." },
    },
    post: {
      id: "webhooks.triggerPost",
      summary: "The same trigger, taking the payload as the body. Any payload, including a bare string — it is the caller's data.",
      auth: "none",
      pathParams: [["path", "The trigger path the workflow was registered with."]],
      responses: { "202": "A run started.", "401": "Wrong secret.", "404": "No active workflow on this path." },
    },
  },
  "/api/example-workflow": {
    post: {
      id: "exampleWorkflow.load",
      summary: "Load the example workflow — one click, removable again. Session or key.",
      auth: "session-or-key",
      responses: { "201": "What was loaded." },
    },
    delete: {
      id: "exampleWorkflow.remove",
      summary: "Take the example workflow away.",
      auth: "session-or-key",
      responses: { "200": "It is gone." },
    },
  },
  "/api/ai/try-node": {
    post: {
      id: "ai.tryNode",
      fields: "LLM_TRY_NODE",
      summary: "The AI node playground — what a step will read, before a workflow uses it.",
      auth: "key",
      body: {
        description: "The text to work on, the task, and the extras some tasks take.",
        properties: {
          text: { type: "string", description: "The text the node works on.", required: true },
          task: { type: "string", description: "One of the node's tasks, e.g. summarize." },
          labels: { type: "array", description: "Classification labels." },
          fields: { type: "array", description: "Extraction fields." },
          model: { type: "string", description: "The model to run." },
        },
      },
      responses: { "200": "The node's answer, or why there is none." },
    },
  },
  "/api/export": {
    get: {
      id: "export.workspace",
      summary: "The whole workspace as one JSON file.",
      auth: "session",
      responses: { "200": "The workflow." },
    },
  },
  "/api/export/executions": {
    get: {
      id: "export.executions",
      summary: "The runs as a streamed execution-audit CSV.",
      auth: "session",
      responses: { "200": "The CSV." },
    },
  },
};

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "AbetFlow API",
    version: VERSION,
    description:
      "Workflow plumbing: inbound webhooks start multi-step runs, steps call your endpoints and transform payloads with JSONata, and every completed run publishes a signed webhook.",
    contact: { name: "Abetworks", email: "support@abetworks.in" },
    license: { name: "Proprietary" },
  },
  servers: [{ url: "https://flow.abetworks.in" }],
  paths: Object.fromEntries(
    Object.entries(PATHS).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item)
          .filter(([method]) => ["get", "post", "patch", "put", "delete"].includes(method))
          .map(([method, operation]) => [method, op(method as Method, operation as Operation)]),
      ),
    ]),
  ),
  components: {
    securitySchemes: {
      apiKey: {
        type: "http",
        scheme: "bearer",
        description: "A workspace API key, as 'Authorization: Bearer <key>' or 'x-api-key: <key>'.",
      },
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "abetworks_session",
        description: "The signed-in browser session — for the export routes.",
      },
    },
  },
};

/** The operations, flattened: what the contract check reasons about. */
export const openapiOperations: { path: string; method: Method; operation: Operation }[] =
  Object.entries(PATHS).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({
      path,
      method: method as Method,
      operation: operation as Operation,
    })),
  );
