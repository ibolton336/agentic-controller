/**
 * hub-shim — localhost gateway serving the SHIM HTTP API v1.
 *
 * Stands in for the future Konveyor Hub passthrough proxy so browser UIs
 * can drive the real agentic-controller today. Browsers cannot set the
 * X-Secret-Key upgrade header nor reach the sandbox pod; this shim owns
 * both: it resolves a run's ACP endpoint (pod by status.sandboxName, key
 * from status.secretKeyRef), reaches the pod (port-forward tunnel on a
 * laptop, direct service-DNS dial in-cluster), and pipes WebSocket frames
 * between the browser and the pod's :4000/acp.
 *
 * Routes:
 *   GET    /healthz                     -> 200 "ok"
 *   GET    /api/applications            -> 200 Application[] (mock inventory)
 *   GET    /api/agents[/:name]          -> 200 Agent[] | Agent | 404
 *                                          (list filtered: konveyor.io/managed=true)
 *   GET    /api/llmproviders[/:name]    -> 200 LLMProvider[] | LLMProvider | 404
 *   GET    /api/skillcards[/:name]      -> 200 SkillCard[] | SkillCard | 404
 *   GET    /api/skillcollections[/:name]-> 200 SkillCollection[] | SkillCollection | 404
 *   GET    /api/agentruns               -> 200 AgentRun[]
 *   POST   /api/agentruns               -> 201 AgentRun (generateName "ui-";
 *                                          applicationRef -> Hub coordinates +
 *                                          TARGET_BRANCH injected as spec.env)
 *   GET    /api/agentruns/:name         -> 200 AgentRun | 404
 *   DELETE /api/agentruns/:name         -> 204 | 404
 *   WS     /api/agentruns/:name/acp     -> bidirectional pipe to the pod
 *   GET    /api/agentplaybooks[/:name]  -> 200 AgentPlaybook[] | AgentPlaybook | 404
 *   GET    /api/agentplaybookruns       -> 200 AgentPlaybookRun[]
 *   POST   /api/agentplaybookruns       -> 201 AgentPlaybookRun (generateName
 *                                          "ui-"; models resolved vs the union
 *                                          of stage Agents; applicationRef ->
 *                                          the same env injection, forwarded
 *                                          to every stage)
 *   GET    /api/agentplaybookruns/:name -> 200 AgentPlaybookRun | 404
 *   DELETE /api/agentplaybookruns/:name -> 204 | 404 (stage runs cascade)
 *   GET    /api/images                  -> 200 AgentImage[] (agent-image
 *                                          catalog ConfigMap, else the
 *                                          built-in hierarchy)
 *   POST   /api/defaults                -> 200 SeedResult[] (seeds the
 *                                          default managed resource set;
 *                                          idempotent, create-only)
 *
 * Catalog writes (the Hub R1 write proposal) — for each of agents,
 * skillcards, skillcollections, agentplaybooks:
 *   POST   /api/<plural>                -> 201 CR    body {name, spec};
 *                                          named create, konveyor.io/managed
 *                                          stamped; 409 when the name exists
 *   PUT    /api/<plural>/:name          -> 200 CR    body {spec}; replaces
 *                                          the spec, preserves metadata,
 *                                          stamps the managed label (editing
 *                                          ADOPTS an unlabeled resource);
 *                                          404 absent, 409 write conflict
 *   DELETE /api/<plural>/:name          -> 204 | 404
 * Thin passthrough by design (issue-22 placement): CRD schema/CEL failures
 * surface as the apiserver's 4xx + message, not shim-side re-validation.
 * List filtering: agents, skillcards, skillcollections, agentplaybooks are
 * managed-label filtered; llmproviders (admin-owned) and both run kinds
 * (stage runs are controller-created and unlabeled; other callers' runs
 * must stay visible) are NOT.
 *
 * The Konveyor-aware harness pulls the application's repo, decrypted git
 * identity, and analysis from the Hub itself (keyed by the injected env) —
 * the ADR 0005 param/credential-source resolution formerly performed here is
 * RETIRED for the platform path.
 *
 * No auth on the shim itself — localhost dev tool only. CORS `*` on /api/*.
 */
import * as http from "node:http";
import * as k8s from "@kubernetes/client-node";
import { WebSocket as WsWebSocket, WebSocketServer, type RawData } from "ws";
// Reused from the sibling POC package (tsx resolves cross-package TS imports).
// kube.ts implements waitForAcpEndpoint with the verified real-controller
// semantics: pod resolved by status.sandboxName (NOT labels), secret key read
// from "secret-key" / "ACP_SECRET_KEY" / sole-entry fallback.
import { AgentRunClient } from "../../agentrun-client/src/kube.js";
import { openTunnel, type Tunnel } from "../../agentrun-client/src/portforward.js";
import { connectUpstream } from "./acp-dial.js";
import {
  API_VERSION,
  GROUP,
  VERSION,
  PLURALS,
  type Agent,
  type AgentPlaybook,
  type AgentPlaybookRun,
  type AgentPlaybookRunSpec,
  type AgentRun,
  type AgentRunModelSelection,
  type AgentRunSpec,
  type EnvFromSource,
  type EnvVar,
  type LLMProvider,
} from "../../agentrun-client/src/types.js";
import {
  IMAGE_CATALOG_CONFIGMAP,
  IMAGE_CATALOG_KEY,
  MANAGED_LABEL,
  RESOURCE_NAME_MAX,
  RESOURCE_NAME_PATTERN,
  RUN_ENV,
  defaultTargetBranch,
  invalidTargetBranchReason,
  type AgentImage,
  type Application,
  type SeedResult,
} from "../../agentic-client/src/contract/index.js";
import { DEFAULT_IMAGE_CATALOG, defaultResources, imageCatalogConfigMap } from "./defaults.js";

const PORT = Number(process.env.PORT ?? 7080);
const HOST = process.env.HOST ?? "127.0.0.1";
const NAMESPACE = process.env.NAMESPACE ?? "konveyor-agents";
const ACP_RESOLVE_TIMEOUT_MS = 60_000;
/**
 * Upstream liveness probe interval. The port-forward tunnel can die without
 * the upstream WebSocket ever seeing a close/error (the tunnel fix in
 * portforward.ts covers the known path, but any silent-death mode — wedged
 * API-server stream, network partition to the cluster — leaves the bridge
 * piping into a void). Ping the upstream every interval; a peer that neither
 * pongs nor sends any frame for a full interval is declared dead and the
 * browser client is closed with 1011 instead of hanging forever. 0 disables.
 */
const ACP_KEEPALIVE_MS = Number(process.env.ACP_KEEPALIVE_MS ?? 10_000);

/**
 * How to reach a sandbox pod's :4000.
 *  - "tunnel": Kubernetes port-forward (the laptop-dev substitute).
 *  - "direct": dial the run's headless-Service DNS name — the in-cluster
 *    path, and what the real Hub proxy will do.
 * Auto-detect: in-cluster (serviceaccount env present) means direct.
 */
const ACP_DIAL =
  process.env.ACP_DIAL === "direct" || process.env.ACP_DIAL === "tunnel"
    ? process.env.ACP_DIAL
    : process.env.KUBERNETES_SERVICE_HOST
      ? "direct"
      : "tunnel";

const log = (msg: string) => console.log(`[hub-shim] ${msg}`);
const warn = (msg: string) => console.warn(`[hub-shim] ${msg}`);

// runClient owns its own KubeConfig (loadFromDefault: respects $KUBECONFIG).
// A second KubeConfig is loaded from this package's @kubernetes/client-node
// copy for list calls — the two copies' classes have private members, so
// instances must never cross between them.
const runClient = new AgentRunClient({ namespace: NAMESPACE });
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const custom = kc.makeApiClient(k8s.CustomObjectsApi);
const core = kc.makeApiClient(k8s.CoreV1Api);

async function listCustom<T extends { apiVersion?: string; kind?: string }>(
  plural: string,
  kind: string,
  labelSelector?: string,
): Promise<T[]> {
  const res = (await custom.listNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: NAMESPACE,
    plural,
    labelSelector,
  })) as { items?: T[] };
  // List items omit apiVersion/kind; restore them so clients get full CRs.
  return (res.items ?? []).map((item) => ({ apiVersion: API_VERSION, kind, ...item }));
}

async function getCustom(plural: string, kind: string, name: string): Promise<object> {
  const obj = (await custom.getNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: NAMESPACE,
    plural,
    name,
  })) as Record<string, unknown>;
  return { apiVersion: API_VERSION, kind, ...obj };
}

/** Resources served read-only as full CRs: list + get by name. */
const READ_ONLY: Record<string, string> = {
  [PLURALS.Agent]: "Agent",
  [PLURALS.AgentPlaybook]: "AgentPlaybook",
  [PLURALS.AgentPlaybookRun]: "AgentPlaybookRun",
  [PLURALS.LLMProvider]: "LLMProvider",
  [PLURALS.SkillCard]: "SkillCard",
  [PLURALS.SkillCollection]: "SkillCollection",
};

/**
 * Konveyor UIs only see catalog resources that opt into platform management
 * (everything the UI creates is stamped). Deliberately unfiltered:
 * llmproviders (cluster-admin-owned, never UI-created) and both run kinds
 * (stage AgentRuns are controller-created without the label, and runs from
 * other callers — RHDH, kubectl — must stay visible). Get-by-name is never
 * filtered, so unlabeled stage agents remain introspectable.
 */
const LIST_LABEL_SELECTORS: Record<string, string> = {
  [PLURALS.Agent]: `${MANAGED_LABEL}=true`,
  [PLURALS.SkillCard]: `${MANAGED_LABEL}=true`,
  [PLURALS.SkillCollection]: `${MANAGED_LABEL}=true`,
  [PLURALS.AgentPlaybook]: `${MANAGED_LABEL}=true`,
};

/**
 * Resources the catalog write routes manage (POST/PUT/DELETE). Run kinds are
 * NOT here — their write paths (generateName, env/model injection, cascade
 * semantics) are bespoke and live in handleApi directly.
 */
const WRITABLE: Record<string, string> = {
  [PLURALS.Agent]: "Agent",
  [PLURALS.SkillCard]: "SkillCard",
  [PLURALS.SkillCollection]: "SkillCollection",
  [PLURALS.AgentPlaybook]: "AgentPlaybook",
};

/**
 * Real Konveyor Hub REST base. In-cluster this is the Hub service DNS
 * (http://tackle2-hub.<ns>.svc:8080); on a laptop, a port-forward or
 * NodePort. When unset/unreachable the shim falls back to STUB_APPLICATIONS
 * so it still runs offline. This is the production-shaped knob: the real
 * Hub-proxy reads its own Application table; the shim reads it over HTTP.
 */
const HUB_URL = process.env.HUB_URL?.replace(/\/+$/, "");

/**
 * Hub coordinates injected into run pods (RUN_ENV). The harness dials the
 * Hub FROM THE SANDBOX POD, so on a laptop — where HUB_URL is typically a
 * localhost port-forward the pod cannot reach — set RUN_HUB_BASE_URL to the
 * in-cluster service DNS (e.g. http://tackle2-hub.konveyor-tackle.svc:8080).
 * Defaults to HUB_URL, which is correct when the shim itself runs in-cluster.
 */
const RUN_HUB_BASE_URL = process.env.RUN_HUB_BASE_URL?.replace(/\/+$/, "") ?? HUB_URL;

/**
 * Bearer token for the Hub. Used on the shim's own inventory reads AND
 * delivered to run pods as HUB_TOKEN (via a Secret-backed valueFrom, never
 * plaintext in the CR). Optional only against an UNAUTHENTICATED Hub — repo
 * visibility is irrelevant, since the harness always resolves the
 * application through the Hub before touching git.
 */
const HUB_TOKEN = process.env.HUB_TOKEN;

/**
 * Offline fallback when HUB_URL is unset or the Hub is unreachable. The id
 * is numeric because the harness's ParseAppID requires a uint string — but a
 * run created against the stub still needs a REAL Hub to resolve app 1, so
 * stub-mode runs are only useful for agents that ignore the application
 * (e.g. the mock fixture).
 */
const STUB_APPLICATIONS: Application[] = [
  {
    id: "1",
    name: "Coolstore (stub — Hub unavailable)",
    repository: { url: "https://github.com/konveyor-ecosystem/coolstore.git", branch: "main" },
  },
];

interface HubApp {
  id: number;
  name: string;
  repository?: { url?: string; branch?: string };
  identities?: { id: number; name?: string }[];
}
interface HubIdentity {
  id: number;
  name: string;
  kind: string;
}

async function hubGet<T>(path: string): Promise<T> {
  const res = await fetch(`${HUB_URL}/${path}`, {
    headers: {
      accept: "application/json",
      ...(HUB_TOKEN ? { authorization: `Bearer ${HUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`Hub GET /${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The platform's application inventory. Reads real Hub Applications and maps
 * them to the client Application shape: repository straight from Hub; the
 * source-control Identity carried as a reference (identity.name) plus its
 * bridged Secret when one exists. Falls back to STUB_APPLICATIONS offline.
 */
/** Where the inventory came from — surfaced to the UI so "real vs stub" is visible. */
interface Inventory {
  source: "hub" | "stub";
  endpoint: string;
  applications: Application[];
}

async function getApplications(): Promise<Inventory> {
  if (!HUB_URL) {
    return { source: "stub", endpoint: "offline stub (HUB_URL unset)", applications: STUB_APPLICATIONS };
  }
  try {
    const [apps, identities] = await Promise.all([
      hubGet<HubApp[]>("applications"),
      hubGet<HubIdentity[]>("identities"),
    ]);
    const sourceKind = new Map(identities.map((i) => [i.id, i.kind]));
    const applications = apps.map((a): Application => {
      const srcRef = (a.identities ?? []).find((r) => sourceKind.get(r.id) === "source");
      const idName = srcRef?.name;
      return {
        id: String(a.id),
        name: a.name,
        repository: a.repository?.url
          ? { url: a.repository.url, branch: a.repository.branch }
          : undefined,
        identity: idName ? { name: idName } : undefined,
      };
    });
    return { source: "hub", endpoint: HUB_URL, applications };
  } catch (err) {
    warn(`Hub inventory unavailable (${errorMessage(err)}); using offline stub`);
    return { source: "stub", endpoint: "offline stub (Hub unreachable)", applications: STUB_APPLICATIONS };
  }
}

// ---------------------------------------------------------------- HTTP api

/**
 * A fault attributable to the caller (-> 400). Everything else — including
 * apiserver transport failures, which carry a STRING `code` like
 * "ECONNREFUSED" and so are invisible to k8sStatusCode — must bubble to the
 * top-level handler and become a 5xx. Never infer "client fault" from the
 * absence of a numeric status code.
 */
class BadRequestError extends Error {}

// Explicitly typed so TS control-flow analysis treats a call as unreachable
// past this point (narrowing after `if (!x) badRequest(...)`).
const badRequest: (message: string) => never = (message) => {
  throw new BadRequestError(message);
};

function k8sStatusCode(err: unknown): number | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "number" && code >= 400 && code <= 599) return code;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1_048_576) badRequest("request body too large (max 1 MiB)");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) badRequest("request body is empty; expected JSON");
  try {
    return JSON.parse(text);
  } catch {
    badRequest("request body is not valid JSON");
  }
}

/**
 * The apiserver's own Status message from a @kubernetes/client-node error
 * (CEL/schema rejections, AlreadyExists, Conflict) — far more actionable
 * than the generic HTTP-code message the client wraps around it.
 */
function k8sMessage(err: unknown): string {
  if (err && typeof err === "object" && "body" in err) {
    const body = (err as { body: unknown }).body;
    if (typeof body === "string") {
      try {
        const status = JSON.parse(body) as { message?: unknown };
        if (typeof status.message === "string" && status.message) return status.message;
      } catch {
        if (body.trim()) return body.slice(0, 500);
      }
    } else if (body && typeof body === "object") {
      const message = (body as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
  }
  return errorMessage(err);
}

// ----------------------------------------------------------- catalog writes

interface SaveResourceBody {
  name?: string;
  spec: object;
}

/**
 * Validates a catalog write body: {name, spec} on POST, {spec} on PUT (a
 * body name is tolerated only when it matches the path). Spec contents are
 * NOT validated here — the CRD schema + CEL rules on the apiserver are the
 * single source of truth, and their messages pass through (k8sMessage).
 */
function parseSaveBody(raw: unknown, pathName: string | undefined): SaveResourceBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    badRequest(pathName ? "body must be a JSON object: {spec}" : "body must be a JSON object: {name, spec}");
  }
  const body = raw as Record<string, unknown>;
  let name: string | undefined = pathName;
  if (pathName === undefined) {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      badRequest("name is required and must be a non-empty string");
    }
    name = body.name.trim();
    if (name.length > RESOURCE_NAME_MAX || !RESOURCE_NAME_PATTERN.test(name)) {
      badRequest(
        `name "${name}" is not a valid resource name (lowercase DNS-1123, max ${RESOURCE_NAME_MAX} chars)`,
      );
    }
  } else if (body.name !== undefined && body.name !== pathName) {
    badRequest(`body.name "${String(body.name)}" does not match the path ("${pathName}")`);
  }
  if (!body.spec || typeof body.spec !== "object" || Array.isArray(body.spec)) {
    badRequest("spec is required and must be an object");
  }
  return { name, spec: body.spec as object };
}

/** Managed-label-stamped metadata for a catalog create. */
function managedMetadata(name: string): object {
  return { name, namespace: NAMESPACE, labels: { [MANAGED_LABEL]: "true" } };
}

interface CreateRunBody {
  agentRef: string;
  params?: Record<string, string>;
  instructions?: string;
  applicationRef?: string;
  targetBranch?: string;
  /** Explicit "primary"-role selection; absent = default provider policy. */
  model?: { provider: string; model: string };
}

/**
 * Secret carrying HUB_TOKEN into run pods. The token must never appear as a
 * plaintext spec.env value: the CR would put it in etcd, and this shim —
 * unauthenticated, CORS * — would echo it to every browser on run list/get.
 * Instead the shim upserts this Secret once and injects a valueFrom ref;
 * only the Secret NAME ever crosses the API.
 */
const HUB_TOKEN_SECRET = "hub-shim-hub-token";
const HUB_TOKEN_SECRET_KEY = "token";
let hubTokenSecretReady: Promise<void> | undefined;

function ensureHubTokenSecret(): Promise<void> {
  hubTokenSecretReady ??= (async () => {
    const body = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: HUB_TOKEN_SECRET, namespace: NAMESPACE },
      type: "Opaque",
      stringData: { [HUB_TOKEN_SECRET_KEY]: HUB_TOKEN ?? "" },
    };
    try {
      await core.replaceNamespacedSecret({ name: HUB_TOKEN_SECRET, namespace: NAMESPACE, body });
    } catch (err) {
      if (k8sStatusCode(err) !== 404) throw err;
      await core.createNamespacedSecret({ namespace: NAMESPACE, body });
    }
    log(`hub token Secret ${HUB_TOKEN_SECRET} upserted`);
  })();
  // A failed upsert must not poison every later create with the same
  // rejected promise — retry next time.
  hubTokenSecretReady.catch(() => {
    hubTokenSecretReady = undefined;
  });
  return hubTokenSecretReady;
}

/**
 * The platform's contribution to a run that works on an application: the
 * Hub coordinates + application id + target branch, injected as spec.env
 * (RUN_ENV). The Konveyor-aware harness pulls everything else — repo URL,
 * decrypted git identity, analysis — from the Hub itself, in-pod, and
 * withholds the credentials from the agent. This replaces the retired
 * ADR 0005 param/credential-source resolution.
 */
async function hubEnvForRun(
  applicationRef: string,
  targetBranch: string | undefined,
): Promise<EnvVar[]> {
  // Creating an application-scoped run against stub data would inject a
  // fabricated APP_ID the real Hub can't resolve. Not the caller's fault,
  // so a plain Error (-> 5xx), unlike the 400s below.
  const inv = await getApplications();
  if (inv.source !== "hub") {
    throw new Error(
      `application inventory unavailable (${inv.endpoint}) — cannot create an ` +
        `application-scoped run against stub data; retry when the Hub is reachable`,
    );
  }
  const app = inv.applications.find((a) => a.id === applicationRef);
  if (!app) {
    badRequest(
      `unknown applicationRef "${applicationRef}" — GET /api/applications lists the inventory`,
    );
  }
  if (!/^\d+$/.test(app.id)) {
    badRequest(
      `application id "${app.id}" is not numeric — the harness's APP_ID parser requires a ` +
        `uint Hub id`,
    );
  }
  if (!app.repository?.url) {
    badRequest(
      `application "${app.id}" has no repository URL — the harness clones from the Hub ` +
        `record; set the application's source repository first`,
    );
  }
  if (!RUN_HUB_BASE_URL) {
    badRequest(
      "applicationRef needs a Hub the SANDBOX POD can reach: set HUB_URL (in-cluster) or " +
        "RUN_HUB_BASE_URL (laptop dev, pointing at the Hub's in-cluster service DNS)",
    );
  }
  // The pod dials this URL, not the shim: a laptop port-forward loopback
  // address is unreachable from inside the cluster.
  let hubHost: string;
  try {
    hubHost = new URL(RUN_HUB_BASE_URL).hostname;
  } catch {
    badRequest(`RUN_HUB_BASE_URL/HUB_URL "${RUN_HUB_BASE_URL}" is not a valid URL`);
  }
  if (ACP_DIAL === "tunnel" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hubHost)) {
    badRequest(
      `Hub base URL "${RUN_HUB_BASE_URL}" is loopback but the shim is not in-cluster — the ` +
        `sandbox pod cannot reach the laptop's port-forward; set RUN_HUB_BASE_URL to the ` +
        `Hub's in-cluster service DNS (e.g. http://tackle2-hub.konveyor-tackle.svc:8080)`,
    );
  }
  const branch = (targetBranch ?? defaultTargetBranch()).trim();
  const branchProblem = invalidTargetBranchReason(branch);
  if (branchProblem) {
    badRequest(`targetBranch "${branch}" is ${branchProblem}`);
  }
  if (app.repository?.branch && branch === app.repository.branch) {
    badRequest(
      `targetBranch "${branch}" equals application "${app.id}"'s source branch — the harness ` +
        `refuses to push onto the source branch; pick any other name`,
    );
  }
  const env: EnvVar[] = [
    { name: RUN_ENV.HUB_BASE_URL, value: RUN_HUB_BASE_URL },
    { name: RUN_ENV.APP_ID, value: app.id },
    { name: RUN_ENV.TARGET_BRANCH, value: branch },
  ];
  if (HUB_TOKEN) {
    await ensureHubTokenSecret();
    env.splice(1, 0, {
      name: RUN_ENV.HUB_TOKEN,
      valueFrom: { secretKeyRef: { name: HUB_TOKEN_SECRET, key: HUB_TOKEN_SECRET_KEY } },
    });
  }
  return env;
}

/**
 * Fetches an Agent, tolerating 404 (undefined) — single-run creation leaves
 * an unknown agentRef for the controller to report, matching the CR-level
 * behavior a kubectl user would see.
 */
async function fetchAgent(agentRef: string): Promise<Agent | undefined> {
  try {
    return (await getCustom(PLURALS.Agent, "Agent", agentRef)) as Agent;
  } catch (err) {
    if (k8sStatusCode(err) === 404) return undefined;
    throw err;
  }
}

/**
 * The migration-harness fails fatally when /opt/skills mounts nothing, so an
 * application-scoped run on a skill-less Agent is doomed. A warning rather
 * than a 400: fixtures (mock harness) legitimately run skill-less, and the
 * shim cannot tell a fixture from a misconfigured migration agent.
 */
function warnIfNoSkills(agent: Agent | undefined, forWhom: string): void {
  if (!agent?.metadata?.name) return;
  const skills = (agent.spec.skillCards?.length ?? 0) + (agent.spec.skillCollections?.length ?? 0);
  if (skills === 0) {
    warn(
      `${forWhom}: Agent "${agent.metadata.name}" declares no skillCards/skillCollections — ` +
        `the migration-harness fatals with zero mounted skills`,
    );
  }
}

/**
 * The run's model selection + LLM-provider credentials, defaulted from the
 * Agent's declared providers — the platform-side policy the controller does
 * not perform for itself.
 *
 * The controller turns spec.models into KONVEYOR_MODEL_{ROLE}_* env. Since
 * #34 it also handles SigV4-style providers itself: a keyless credentialRef
 * exposes the whole credential Secret to the sandbox via envFrom. The
 * envFrom we add here duplicates that for keyless providers (same secret,
 * harmless) and remains the only credential path against pre-#34
 * controllers. The secretRef is `optional` so a provider whose secret has
 * not been created (e.g. the mock provider) still lets the run start — the
 * harness warns at runtime instead of the pod wedging on a missing Secret.
 *
 * Defaults to the Agent's first declared provider and that provider's
 * primary-tier model (else its first). Best-effort: an agent with no
 * provider, an unresolvable LLMProvider, or a provider with no models
 * contributes nothing — fine for fixtures, but the migration-harness has
 * NO model defaults (KONVEYOR_MODEL_PRIMARY_* is hard-required, it fails
 * at startup without them), so the create paths warn when an
 * application-scoped run resolves no model.
 */
async function resolveModels(
  agent: Agent | undefined,
  agentRef: string,
): Promise<{ models: AgentRunModelSelection[]; envFrom: EnvFromSource[] }> {
  const empty = { models: [] as AgentRunModelSelection[], envFrom: [] as EnvFromSource[] };
  // Unknown agent: let createAgentRun proceed and the controller report it.
  if (!agent) return empty;
  const providerRef = agent.spec.providers?.[0]?.ref;
  if (!providerRef) return empty;
  return resolveProviderModel(providerRef, `agent "${agentRef}"`);
}

/**
 * Model selection for a playbook run. spec.models applies to EVERY stage
 * and there are no per-stage overrides, so the pick must come from the
 * INTERSECTION of the stage Agents' full declared provider lists (the same
 * set an explicit selection validates against) — a provider only some
 * stages declare would fail those stages at reconcile. An empty
 * intersection is a 400, not a silent pick; the first stage Agent's
 * declaration order breaks ties.
 */
async function resolvePlaybookModels(
  playbookRef: string,
  agents: Agent[],
): Promise<{ models: AgentRunModelSelection[]; envFrom: EnvFromSource[] }> {
  const declaring = agents.filter((a) => (a.spec.providers ?? []).length > 0);
  if (declaring.length === 0) return { models: [], envFrom: [] };
  const shared = (declaring[0].spec.providers ?? [])
    .map((p) => p.ref)
    .filter((ref) => declaring.every((a) => (a.spec.providers ?? []).some((p) => p.ref === ref)));
  if (shared.length === 0) {
    const perStage = declaring
      .map((a) => `${a.metadata.name}: ${(a.spec.providers ?? []).map((p) => p.ref).join("/")}`)
      .join("; ");
    badRequest(
      `playbook "${playbookRef}" stage Agents share no LLM provider (${perStage}) — ` +
        `spec.models applies to every stage and per-stage overrides do not exist yet`,
    );
  }
  return resolveProviderModel(shared[0], `playbook "${playbookRef}"`);
}

/** The provider's primary-tier model (else first) + its credential Secret. */
async function resolveProviderModel(
  providerRef: string,
  forWhom: string,
): Promise<{ models: AgentRunModelSelection[]; envFrom: EnvFromSource[] }> {
  const empty = { models: [] as AgentRunModelSelection[], envFrom: [] as EnvFromSource[] };
  let provider: LLMProvider;
  try {
    provider = (await getCustom(PLURALS.LLMProvider, "LLMProvider", providerRef)) as LLMProvider;
  } catch (err) {
    if (k8sStatusCode(err) === 404) {
      log(`${forWhom} declares provider "${providerRef}" but no such LLMProvider — no model injected`);
      return empty;
    }
    throw err;
  }

  const model =
    (provider.spec.models?.find((m) => m.tier === "primary") ?? provider.spec.models?.[0])?.name;
  if (!model) {
    log(`LLMProvider "${providerRef}" lists no models — no model injected`);
    return empty;
  }

  const models: AgentRunModelSelection[] = [{ role: "primary", provider: providerRef, model }];
  const secretName = provider.spec.credentialRef?.secretName;
  const envFrom: EnvFromSource[] = secretName
    ? [{ secretRef: { name: secretName, optional: true } }]
    : [];
  warnUnknownGooseProvider(providerRef);
  log(
    `model: ${providerRef}/${model} for ${forWhom}` +
      (secretName ? ` (+creds secret ${secretName})` : ""),
  );
  return { models, envFrom };
}

/**
 * An EXPLICIT caller model selection ({provider, model} on the create body).
 * Unlike the default policy — which is best-effort, because the caller asked
 * for nothing — an explicit choice fails loudly: a provider outside the
 * (stage) Agents' declared providers, an unknown LLMProvider CR, or an
 * undeclared model are 400s, since the controller/harness would only reject
 * them later and less legibly. `agents` holds every known Agent the
 * selection must satisfy (single run: the one agent, when it resolves;
 * playbook: every stage agent).
 */
async function resolveExplicitModel(
  choice: { provider: string; model: string },
  agents: Agent[],
): Promise<{ models: AgentRunModelSelection[]; envFrom: EnvFromSource[] }> {
  for (const agent of agents) {
    const declared = (agent.spec.providers ?? []).map((p) => p.ref);
    if (!declared.includes(choice.provider)) {
      badRequest(
        `model.provider "${choice.provider}" is not among Agent "${agent.metadata.name}"'s ` +
          `declared providers (${declared.join(", ") || "none"})`,
      );
    }
  }
  let provider: LLMProvider;
  try {
    provider = (await getCustom(
      PLURALS.LLMProvider,
      "LLMProvider",
      choice.provider,
    )) as LLMProvider;
  } catch (err) {
    if (k8sStatusCode(err) === 404) {
      badRequest(
        `unknown LLMProvider "${choice.provider}" — GET /api/llmproviders lists them`,
      );
    }
    throw err;
  }
  if (!provider.spec.models?.some((m) => m.name === choice.model)) {
    const declared = (provider.spec.models ?? []).map((m) => m.name);
    badRequest(
      `model "${choice.model}" is not declared on LLMProvider "${choice.provider}" ` +
        `(declared: ${declared.join(", ") || "none"})`,
    );
  }
  const models: AgentRunModelSelection[] = [
    { role: "primary", provider: choice.provider, model: choice.model },
  ];
  const secretName = provider.spec.credentialRef?.secretName;
  const envFrom: EnvFromSource[] = secretName
    ? [{ secretRef: { name: secretName, optional: true } }]
    : [];
  warnUnknownGooseProvider(choice.provider);
  log(`model: ${choice.provider}/${choice.model} (explicit caller selection)`);
  return { models, envFrom };
}

/**
 * goose provider ids the migration-harness's verbatim name mapping can hit
 * (CR name lowercased, "-" -> "_"). Advisory only — goose grows providers,
 * so an unknown id is a warning, never a 400.
 */
const KNOWN_GOOSE_PROVIDER_IDS = new Set([
  "anthropic",
  "aws_bedrock",
  "azure_openai",
  "databricks",
  "gcp_vertex_ai",
  "google",
  "groq",
  "litellm",
  "ollama",
  "openai",
  "openrouter",
  "xai",
]);

/**
 * The migration-harness maps the LLMProvider CR NAME to a goose provider id
 * verbatim (lowercased, "-" -> "_") — a CR named "bedrock" no longer means
 * aws_bedrock. Warn at create time so the misname surfaces here instead of
 * as a goose startup failure inside the pod.
 */
function warnUnknownGooseProvider(providerRef: string): void {
  const gooseId = providerRef.toLowerCase().replace(/-/g, "_");
  if (!KNOWN_GOOSE_PROVIDER_IDS.has(gooseId)) {
    warn(
      `LLMProvider "${providerRef}" maps to goose provider id "${gooseId}", which is not a ` +
        `known goose provider — the harness maps CR names verbatim; if goose rejects it, ` +
        `rename the CR (e.g. "aws-bedrock" -> aws_bedrock)`,
    );
  }
}

/** Validates a body's optional params field as an object of string values. */
function parseParamsField(body: Record<string, unknown>): Record<string, string> | undefined {
  if (body.params === undefined) return undefined;
  if (!body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
    badRequest("params must be an object of string values");
  }
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.params as Record<string, unknown>)) {
    if (typeof value !== "string") {
      badRequest(`params.${key} must be a string`);
    }
    params[key] = value;
  }
  return params;
}

/** Validates an optional model field: {provider, model}, both non-empty. */
function parseModelField(
  body: Record<string, unknown>,
): { provider: string; model: string } | undefined {
  if (body.model === undefined) return undefined;
  const m = body.model;
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    badRequest('model must be an object: {"provider": "...", "model": "..."}');
  }
  const { provider, model } = m as Record<string, unknown>;
  if (typeof provider !== "string" || provider.trim() === "") {
    badRequest("model.provider must be a non-empty string");
  }
  if (typeof model !== "string" || model.trim() === "") {
    badRequest("model.model must be a non-empty string");
  }
  return { provider: provider.trim(), model: model.trim() };
}

/**
 * Validates an optional targetBranch field: non-empty and git-refname-valid
 * (shared rules with the UI via invalidTargetBranchReason — the harness
 * would only fail later, inside the pod).
 */
function parseTargetBranchField(body: Record<string, unknown>): string | undefined {
  if (body.targetBranch === undefined) return undefined;
  if (typeof body.targetBranch !== "string" || body.targetBranch.trim() === "") {
    badRequest("targetBranch must be a non-empty string");
  }
  const branch = body.targetBranch.trim();
  const problem = invalidTargetBranchReason(branch);
  if (problem) badRequest(`targetBranch "${branch}" is ${problem}`);
  return branch;
}

/** Validates the POST /api/agentruns body; throws with a client-facing message. */
function parseCreateRunBody(raw: unknown): CreateRunBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    badRequest(
      "body must be a JSON object: {agentRef, params?, instructions?, applicationRef?, targetBranch?, model?}",
    );
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.agentRef !== "string" || body.agentRef.trim() === "") {
    badRequest("agentRef is required and must be a non-empty string");
  }
  const params = parseParamsField(body);
  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    badRequest("instructions must be a string");
  }
  if (
    body.applicationRef !== undefined &&
    (typeof body.applicationRef !== "string" || body.applicationRef.trim() === "")
  ) {
    badRequest("applicationRef must be a non-empty string");
  }
  const targetBranch = parseTargetBranchField(body);
  if (targetBranch !== undefined && body.applicationRef === undefined) {
    badRequest("targetBranch is only meaningful with applicationRef");
  }
  return {
    agentRef: body.agentRef,
    params,
    instructions: body.instructions as string | undefined,
    applicationRef: body.applicationRef as string | undefined,
    targetBranch,
    model: parseModelField(body),
  };
}

interface CreatePlaybookRunBody {
  playbookRef: string;
  params?: Record<string, string>;
  applicationRef?: string;
  targetBranch?: string;
  /** Explicit "primary"-role selection, applied to EVERY stage. */
  model?: { provider: string; model: string };
}

/**
 * Validates the POST /api/agentplaybookruns body. Deliberately NO
 * instructions field: AgentPlaybookRun.spec has none — stage instructions
 * come from the playbook itself.
 */
function parseCreatePlaybookRunBody(raw: unknown): CreatePlaybookRunBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    badRequest(
      "body must be a JSON object: {playbookRef, params?, applicationRef?, targetBranch?, model?}",
    );
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.playbookRef !== "string" || body.playbookRef.trim() === "") {
    badRequest("playbookRef is required and must be a non-empty string");
  }
  const params = parseParamsField(body);
  if (
    body.applicationRef !== undefined &&
    (typeof body.applicationRef !== "string" || body.applicationRef.trim() === "")
  ) {
    badRequest("applicationRef must be a non-empty string");
  }
  const targetBranch = parseTargetBranchField(body);
  if (targetBranch !== undefined && body.applicationRef === undefined) {
    badRequest("targetBranch is only meaningful with applicationRef");
  }
  return {
    playbookRef: body.playbookRef,
    params,
    applicationRef: body.applicationRef as string | undefined,
    targetBranch,
    model: parseModelField(body),
  };
}

/**
 * Loads a playbook and every stage Agent (deduped). Unlike single-run
 * creation — where an unknown agentRef is left for the controller to
 * report — a playbook create fails fast on a missing Agent: params and
 * models resolve against the UNION of stage Agents, so a hole in that
 * union would silently mis-resolve the run.
 */
async function loadPlaybookAgents(
  playbookRef: string,
): Promise<{ playbook: AgentPlaybook; agents: Agent[] }> {
  let playbook: AgentPlaybook;
  try {
    playbook = (await getCustom(
      PLURALS.AgentPlaybook,
      "AgentPlaybook",
      playbookRef,
    )) as AgentPlaybook;
  } catch (err) {
    if (k8sStatusCode(err) === 404) {
      badRequest(`unknown playbookRef "${playbookRef}" — GET /api/agentplaybooks lists them`);
    }
    throw err;
  }
  const refs = [...new Set((playbook.spec.stages ?? []).map((s) => s.agentRef))];
  const agents: Agent[] = [];
  for (const ref of refs) {
    try {
      agents.push((await getCustom(PLURALS.Agent, "Agent", ref)) as Agent);
    } catch (err) {
      if (k8sStatusCode(err) === 404) {
        badRequest(`playbook "${playbookRef}" references unknown Agent "${ref}"`);
      }
      throw err;
    }
  }
  return { playbook, agents };
}

/**
 * The agent-image catalog: the managed ConfigMap when present (cluster data
 * an admin can edit), else the built-in upstream hierarchy — same
 * stub-fallback idiom as the application inventory, with provenance.
 */
async function getImageCatalog(): Promise<{
  images: AgentImage[];
  source: "configmap" | "builtin";
}> {
  let raw: string | undefined;
  try {
    const cm = await core.readNamespacedConfigMap({
      name: IMAGE_CATALOG_CONFIGMAP,
      namespace: NAMESPACE,
    });
    raw = cm.data?.[IMAGE_CATALOG_KEY];
  } catch (err) {
    if (k8sStatusCode(err) !== 404) throw err;
  }
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return { images: parsed as AgentImage[], source: "configmap" };
      }
      warn(`ConfigMap ${IMAGE_CATALOG_CONFIGMAP}'s ${IMAGE_CATALOG_KEY} is not a JSON array`);
    } catch {
      warn(`ConfigMap ${IMAGE_CATALOG_CONFIGMAP}'s ${IMAGE_CATALOG_KEY} is not valid JSON`);
    }
  }
  return { images: DEFAULT_IMAGE_CATALOG, source: "builtin" };
}

/**
 * Seeds the default managed resource set (see defaults.ts) plus the image
 * catalog ConfigMap. Create-only: 409 AlreadyExists reports "exists" and
 * moves on, so re-seeding never clobbers local edits. Any other apiserver
 * error aborts the pass — partial seeds are re-runnable thanks to the
 * idempotency.
 */
async function seedDefaults(): Promise<SeedResult[]> {
  const results: SeedResult[] = [];

  try {
    await core.createNamespacedConfigMap({
      namespace: NAMESPACE,
      body: imageCatalogConfigMap(NAMESPACE),
    });
    results.push({ kind: "ConfigMap", name: IMAGE_CATALOG_CONFIGMAP, status: "created" });
  } catch (err) {
    if (k8sStatusCode(err) !== 409) throw err;
    results.push({ kind: "ConfigMap", name: IMAGE_CATALOG_CONFIGMAP, status: "exists" });
  }

  for (const r of defaultResources()) {
    try {
      await custom.createNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: NAMESPACE,
        plural: r.plural,
        body: { ...r.body, metadata: { ...(r.body.metadata as object), namespace: NAMESPACE } },
      });
      results.push({ kind: r.kind, name: r.name, status: "created" });
    } catch (err) {
      if (k8sStatusCode(err) !== 409) throw err;
      results.push({ kind: r.kind, name: r.name, status: "exists" });
    }
  }

  const created = results.filter((r) => r.status === "created").length;
  log(`seeded defaults: ${created} created, ${results.length - created} already existed`);
  return results;
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const method = req.method ?? "GET";

  if (pathname === "/api/images") {
    if (method !== "GET") return sendError(res, 405, "method not allowed");
    const catalog = await getImageCatalog();
    // Same shape as the inventory: bare array body, provenance in a header.
    return sendJson(res, 200, catalog.images, { "X-Catalog-Source": catalog.source });
  }

  if (pathname === "/api/defaults") {
    if (method !== "POST") return sendError(res, 405, "method not allowed");
    return sendJson(res, 200, await seedDefaults());
  }

  if (pathname === "/api/applications") {
    if (method !== "GET") return sendError(res, 405, "method not allowed");
    const inv = await getApplications();
    // Body stays a bare Application[] (unchanged contract). Provenance rides
    // in headers so the UI can show real-vs-stub without a shape change.
    return sendJson(res, 200, inv.applications, {
      "X-Inventory-Source": inv.source,
      "X-Inventory-Endpoint": inv.endpoint,
    });
  }

  // Playbook-run writes come before the read-only dispatch, whose regex
  // also matches these paths (and would answer 405 for non-GET methods).
  if (pathname === "/api/agentplaybookruns" && method === "POST") {
    let input: CreatePlaybookRunBody;
    let agents: Agent[];
    let hubEnv: EnvVar[];
    let modelSel: { models: AgentRunModelSelection[]; envFrom: EnvFromSource[] };
    try {
      input = parseCreatePlaybookRunBody(await readJsonBody(req));
      agents = (await loadPlaybookAgents(input.playbookRef)).agents;
      // Params forward wholesale to every stage; a param some stage Agent
      // doesn't declare means that stage's AgentRun gets created and
      // immediately marked Failed (reason=InvalidParams) by the controller.
      // Deterministically doomed, so reject at create time.
      for (const name of Object.keys(input.params ?? {})) {
        const missing = agents.filter((a) => !a.spec.params?.some((p) => p.name === name));
        if (missing.length > 0) {
          badRequest(
            `param "${name}" is not declared by stage Agent(s) ` +
              `${missing.map((a) => a.metadata.name).join(", ")} — params forward to every ` +
              `stage, and the controller marks those stages Failed (InvalidParams) ` +
              `immediately; drop the param or declare it on those Agents`,
          );
        }
      }
      hubEnv = input.applicationRef
        ? await hubEnvForRun(input.applicationRef, input.targetBranch)
        : [];
      // An explicit caller selection must satisfy EVERY stage Agent (models
      // apply to all stages); otherwise the default shared-provider policy.
      modelSel = input.model
        ? await resolveExplicitModel(input.model, agents)
        : await resolvePlaybookModels(input.playbookRef, agents);
    } catch (err) {
      // Only caller faults are 400; apiserver transport failures are 5xx.
      if (!(err instanceof BadRequestError)) throw err;
      return sendError(res, 400, errorMessage(err));
    }
    if (input.applicationRef) {
      for (const agent of agents) {
        warnIfNoSkills(agent, `playbook run (${input.playbookRef})`);
      }
      if (modelSel.models.length === 0) {
        warn(
          `playbook run (${input.playbookRef}): no primary model resolved — the ` +
            `migration-harness hard-requires KONVEYOR_MODEL_PRIMARY_MODEL/PROVIDER and ` +
            `will fail at startup`,
        );
      }
    }
    const spec: AgentPlaybookRunSpec = { playbookRef: input.playbookRef };
    const params = { ...(input.params ?? {}) };
    if (Object.keys(params).length > 0) {
      spec.params = Object.entries(params).map(([name, value]) => ({ name, value }));
    }
    if (modelSel.models.length > 0) spec.models = modelSel.models;
    // Hub coordinates + TARGET_BRANCH forward verbatim to every stage's
    // AgentRun — one shared branch is how the stages chain their work.
    if (hubEnv.length > 0) spec.env = hubEnv;
    if (modelSel.envFrom.length > 0) spec.envFrom = modelSel.envFrom;
    const created = (await custom.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: NAMESPACE,
      plural: PLURALS.AgentPlaybookRun,
      body: {
        apiVersion: API_VERSION,
        kind: "AgentPlaybookRun",
        // Managed label: everything the platform creates is stamped (the
        // run LISTS stay unfiltered — the label is provenance, not a gate).
        metadata: {
          generateName: "ui-",
          namespace: NAMESPACE,
          labels: { [MANAGED_LABEL]: "true" },
        },
        spec,
      } satisfies AgentPlaybookRun,
    })) as AgentPlaybookRun;
    const via = input.applicationRef ? ` via application=${input.applicationRef}` : "";
    log(
      `created AgentPlaybookRun ${created.metadata.name} (playbookRef=${input.playbookRef}${via})`,
    );
    return sendJson(res, 201, created);
  }

  const playbookRunMatch = /^\/api\/agentplaybookruns\/([^/]+)$/.exec(pathname);
  if (playbookRunMatch && method === "DELETE") {
    const name = decodeURIComponent(playbookRunMatch[1]);
    try {
      await custom.deleteNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: NAMESPACE,
        plural: PLURALS.AgentPlaybookRun,
        name,
      });
    } catch (err) {
      if (k8sStatusCode(err) === 404) {
        return sendError(res, 404, `AgentPlaybookRun ${name} not found`);
      }
      throw err;
    }
    log(`deleted AgentPlaybookRun ${name} (stage AgentRuns cascade via ownerRefs)`);
    res.writeHead(204).end();
    return;
  }

  // Catalog writes (agents / skillcards / skillcollections / agentplaybooks).
  // Before the read-only dispatch, whose regex also matches these paths and
  // would answer 405 for non-GET. Thin passthrough: the CRD schema + CEL
  // rules on the apiserver validate specs; its message passes through
  // (k8sMessage) with its status code (409 exists/conflict, 422 invalid).
  const writeMatch = /^\/api\/([a-z]+)(?:\/([^/]+))?$/.exec(pathname);
  if (writeMatch && WRITABLE[writeMatch[1]] && method !== "GET") {
    const plural = writeMatch[1];
    const kind = WRITABLE[plural];
    const name = writeMatch[2] === undefined ? undefined : decodeURIComponent(writeMatch[2]);

    if (method === "POST" && name === undefined) {
      let input: SaveResourceBody;
      try {
        input = parseSaveBody(await readJsonBody(req), undefined);
      } catch (err) {
        if (!(err instanceof BadRequestError)) throw err;
        return sendError(res, 400, errorMessage(err));
      }
      let created: object;
      try {
        created = (await custom.createNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: NAMESPACE,
          plural,
          body: {
            apiVersion: API_VERSION,
            kind,
            metadata: managedMetadata(input.name as string),
            spec: input.spec,
          },
        })) as object;
      } catch (err) {
        const status = k8sStatusCode(err);
        if (status !== undefined && status < 500) return sendError(res, status, k8sMessage(err));
        throw err;
      }
      log(`created ${kind} ${input.name}`);
      return sendJson(res, 201, { apiVersion: API_VERSION, kind, ...created });
    }

    if (method === "PUT" && name !== undefined) {
      let input: SaveResourceBody;
      try {
        input = parseSaveBody(await readJsonBody(req), name);
      } catch (err) {
        if (!(err instanceof BadRequestError)) throw err;
        return sendError(res, 400, errorMessage(err));
      }
      // Read-modify-write: keep metadata (resourceVersion gives optimistic
      // concurrency — a concurrent write surfaces as 409), replace the spec,
      // stamp the managed label. Editing an unlabeled resource deliberately
      // ADOPTS it into the platform: it appears in managed lists afterwards.
      let current: { metadata?: { labels?: Record<string, string> } };
      try {
        current = (await getCustom(plural, kind, name)) as {
          metadata?: { labels?: Record<string, string> };
        };
      } catch (err) {
        if (k8sStatusCode(err) === 404) return sendError(res, 404, `${kind} ${name} not found`);
        throw err;
      }
      let replaced: object;
      try {
        replaced = (await custom.replaceNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: NAMESPACE,
          plural,
          name,
          body: {
            apiVersion: API_VERSION,
            kind,
            metadata: {
              ...(current.metadata ?? {}),
              labels: { ...(current.metadata?.labels ?? {}), [MANAGED_LABEL]: "true" },
            },
            spec: input.spec,
          },
        })) as object;
      } catch (err) {
        const status = k8sStatusCode(err);
        if (status !== undefined && status < 500) return sendError(res, status, k8sMessage(err));
        throw err;
      }
      log(`updated ${kind} ${name}`);
      return sendJson(res, 200, { apiVersion: API_VERSION, kind, ...replaced });
    }

    if (method === "DELETE" && name !== undefined) {
      try {
        await custom.deleteNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: NAMESPACE,
          plural,
          name,
        });
      } catch (err) {
        if (k8sStatusCode(err) === 404) return sendError(res, 404, `${kind} ${name} not found`);
        throw err;
      }
      log(`deleted ${kind} ${name}`);
      res.writeHead(204).end();
      return;
    }

    return sendError(res, 405, "method not allowed");
  }

  const roMatch = /^\/api\/([a-z]+)(?:\/([^/]+))?$/.exec(pathname);
  if (roMatch && READ_ONLY[roMatch[1]]) {
    if (method !== "GET") return sendError(res, 405, "method not allowed");
    const plural = roMatch[1];
    const kind = READ_ONLY[plural];
    if (!roMatch[2]) {
      return sendJson(res, 200, await listCustom(plural, kind, LIST_LABEL_SELECTORS[plural]));
    }
    const name = decodeURIComponent(roMatch[2]);
    try {
      return sendJson(res, 200, await getCustom(plural, kind, name));
    } catch (err) {
      if (k8sStatusCode(err) === 404) return sendError(res, 404, `${kind} ${name} not found`);
      throw err;
    }
  }

  if (pathname === "/api/agentruns") {
    if (method === "GET") {
      return sendJson(res, 200, await listCustom<AgentRun>(PLURALS.AgentRun, "AgentRun"));
    }
    if (method === "POST") {
      let input: CreateRunBody;
      let agent: Agent | undefined;
      let hubEnv: EnvVar[];
      let modelSel: { models: AgentRunModelSelection[]; envFrom: EnvFromSource[] };
      try {
        input = parseCreateRunBody(await readJsonBody(req));
        agent = await fetchAgent(input.agentRef);
        hubEnv = input.applicationRef
          ? await hubEnvForRun(input.applicationRef, input.targetBranch)
          : [];
        // Explicit selection validates against the agent when it resolves
        // (an unknown agentRef stays the controller's to report); absent,
        // the default first-provider/primary-tier policy applies.
        modelSel = input.model
          ? await resolveExplicitModel(input.model, agent ? [agent] : [])
          : await resolveModels(agent, input.agentRef);
      } catch (err) {
        // Only caller faults are 400. hubEnvForRun/resolveModels talk to the
        // apiserver inside this try, and a transport failure there is a 5xx.
        if (!(err instanceof BadRequestError)) throw err;
        return sendError(res, 400, errorMessage(err));
      }
      if (input.applicationRef) {
        warnIfNoSkills(agent, `run (${input.agentRef})`);
        if (modelSel.models.length === 0) {
          warn(
            `run (${input.agentRef}): no primary model resolved — the migration-harness ` +
              `hard-requires KONVEYOR_MODEL_PRIMARY_MODEL/PROVIDER and will fail at startup`,
          );
        }
      }
      const spec: AgentRunSpec = { agentRef: input.agentRef };
      const params = { ...(input.params ?? {}) };
      if (Object.keys(params).length > 0) {
        spec.params = Object.entries(params).map(([name, value]) => ({ name, value }));
      }
      if (input.instructions !== undefined) spec.instructions = input.instructions;
      if (modelSel.models.length > 0) spec.models = modelSel.models;
      // Hub coordinates + TARGET_BRANCH ride spec.env; the LLM provider's
      // credential Secret rides envFrom.
      if (hubEnv.length > 0) spec.env = hubEnv;
      if (modelSel.envFrom.length > 0) spec.envFrom = modelSel.envFrom;
      const run = await runClient.createAgentRun(spec, {
        generateName: "ui-",
        // Provenance stamp; run lists stay unfiltered.
        labels: { [MANAGED_LABEL]: "true" },
      });
      const via = input.applicationRef ? ` via application=${input.applicationRef}` : "";
      log(`created AgentRun ${run.metadata.name} (agentRef=${input.agentRef}${via})`);
      return sendJson(res, 201, run);
    }
    return sendError(res, 405, "method not allowed");
  }

  const runMatch = /^\/api\/agentruns\/([^/]+)$/.exec(pathname);
  if (runMatch) {
    const name = decodeURIComponent(runMatch[1]);
    if (method === "GET") {
      try {
        return sendJson(res, 200, await runClient.getAgentRun(name));
      } catch (err) {
        if (k8sStatusCode(err) === 404) return sendError(res, 404, `AgentRun ${name} not found`);
        throw err;
      }
    }
    if (method === "DELETE") {
      try {
        await runClient.deleteAgentRun(name);
      } catch (err) {
        if (k8sStatusCode(err) === 404) return sendError(res, 404, `AgentRun ${name} not found`);
        throw err;
      }
      log(`deleted AgentRun ${name}`);
      res.writeHead(204).end();
      return;
    }
    return sendError(res, 405, "method not allowed");
  }

  sendError(res, 404, `no route for ${pathname}`);
}

/**
 * Request-target parse that cannot take the process down. Node's HTTP parser
 * delivers targets WHATWG URL refuses (e.g. "//" — protocol-relative with an
 * empty host), and the throw would be synchronous inside the listener where
 * no promise .catch protects it — one stray request from a scanner would
 * kill every in-flight ACP bridge.
 */
function safePathname(target: string | undefined): string | undefined {
  try {
    return new URL(target ?? "/", "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

const server = http.createServer((req, res) => {
  const pathname = safePathname(req.url);
  if (pathname === undefined) {
    sendError(res, 400, `malformed request target ${req.url ?? ""}`);
    return;
  }

  if (pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok");
    return;
  }

  if (!pathname.startsWith("/api/")) {
    sendError(res, 404, `no route for ${pathname}`);
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Inventory-Source, X-Inventory-Endpoint, X-Catalog-Source",
  );
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  handleApi(req, res, pathname).catch((err: unknown) => {
    // URIError = malformed percent-encoding in a path segment — a client
    // fault (400), not a shim outage. k8s ApiExceptions keep their status
    // and get the apiserver Status MESSAGE (k8sMessage), not the client
    // library's multi-line blob — same contract the catalog writes honor.
    const status = err instanceof URIError ? 400 : (k8sStatusCode(err) ?? 500);
    warn(`${req.method} ${pathname} failed: ${errorMessage(err)}`);
    if (!res.headersSent) sendError(res, status, k8sMessage(err));
    else res.end();
  });
});

// ------------------------------------------------------------- WS acp pipe

/** Close codes a ws socket is allowed to SEND (mirrors ws's validation). */
function sendableCloseCode(code: number, fallback: number): number {
  if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code;
  if (code >= 3000 && code <= 4999) return code;
  return fallback;
}

/** Close reasons are capped at 123 UTF-8 bytes by the WebSocket protocol. */
function closeReason(text: string): string {
  let reason = text.replace(/\s+/g, " ").trim().slice(0, 123);
  while (Buffer.byteLength(reason, "utf8") > 123) reason = reason.slice(0, -1);
  return reason;
}

async function bridgeAcp(client: WsWebSocket, runName: string): Promise<void> {
  const tag = `acp ${runName}:`;
  log(`${tag} browser client connected`);

  let upstream: WsWebSocket | undefined;
  let tunnel: Tunnel | undefined;
  let clientClosed = false;
  let keepalive: NodeJS.Timeout | undefined;
  /** Frames the browser sent before the upstream socket finished opening. */
  const pendingToUpstream: { data: RawData; isBinary: boolean }[] = [];

  client.on("message", (data: RawData, isBinary: boolean) => {
    if (upstream && upstream.readyState === WsWebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    } else {
      pendingToUpstream.push({ data, isBinary });
    }
  });

  client.on("close", (code: number, reason: Buffer) => {
    clientClosed = true;
    clearInterval(keepalive);
    log(`${tag} client closed (code=${code}${reason.length ? ` reason=${reason.toString()}` : ""})`);
    if (upstream) {
      if (upstream.readyState === WsWebSocket.OPEN) {
        upstream.close(sendableCloseCode(code, 1000), closeReason(reason.toString()));
      } else {
        upstream.terminate();
      }
    }
    tunnel?.close();
  });

  client.on("error", (err: Error) => {
    warn(`${tag} client socket error: ${err.message}`);
  });

  try {
    const endpoint = await runClient.waitForAcpEndpoint(runName, {
      timeoutMs: ACP_RESOLVE_TIMEOUT_MS,
    });
    if (clientClosed) return;

    let target: string;
    if (ACP_DIAL === "direct") {
      // In-cluster: the headless Service's DNS name resolves straight to
      // the pod IP; no port-forward machinery needed.
      target = `ws://${endpoint.serviceHost}:${endpoint.port}/acp`;
      log(`${tag} resolved pod ${endpoint.podName}, dialing ${endpoint.serviceHost}:${endpoint.port}`);
    } else {
      tunnel = await openTunnel(runClient.kc, NAMESPACE, endpoint.podName, endpoint.port);
      if (clientClosed) {
        tunnel.close();
        return;
      }
      log(`${tag} resolved pod ${endpoint.podName}, tunnel 127.0.0.1:${tunnel.localPort}`);
      target = `ws://127.0.0.1:${tunnel.localPort}/acp`;
    }
    // The shim injects the X-Secret-Key header the browser cannot set.
    // connectUpstream retries the dial while the pod's :4000 is not yet
    // accepting connections, so a pod that reports Running/Ready before the
    // harness has bound doesn't surface to the browser as a fatal 1011.
    upstream = await connectUpstream(target, {
      secretKey: endpoint.secretKey,
      tag,
      isClientClosed: () => clientClosed,
      log,
    });
    if (clientClosed) {
      upstream.terminate();
      tunnel?.close();
      return;
    }
    log(`${tag} upstream open, piping frames`);
    for (const frame of pendingToUpstream.splice(0)) {
      upstream.send(frame.data, { binary: frame.isBinary });
    }

    // Liveness: any frame from the upstream (data or pong) proves the path
    // is alive; an interval with neither means the peer or the tunnel died
    // without a close frame. RFC 6455 obliges every endpoint to answer pings,
    // so an idle-but-healthy agent mid-turn still pongs.
    let upstreamAlive = true;
    upstream.on("pong", () => {
      upstreamAlive = true;
    });
    if (ACP_KEEPALIVE_MS > 0) {
      const up = upstream;
      keepalive = setInterval(() => {
        if (up.readyState !== WsWebSocket.OPEN) return;
        if (!upstreamAlive) {
          warn(`${tag} upstream unresponsive for ${ACP_KEEPALIVE_MS}ms, terminating`);
          clearInterval(keepalive);
          if (!clientClosed) {
            client.close(1011, closeReason("upstream unresponsive (keepalive timeout)"));
          }
          // terminate() fires 'close' below, which handles tunnel cleanup.
          up.terminate();
          return;
        }
        upstreamAlive = false;
        up.ping();
      }, ACP_KEEPALIVE_MS);
    }

    upstream.on("message", (data: RawData, isBinary: boolean) => {
      upstreamAlive = true;
      if (client.readyState === WsWebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    upstream.on("close", (code: number, reason: Buffer) => {
      log(`${tag} upstream closed (code=${code})`);
      clearInterval(keepalive);
      tunnel?.close();
      if (!clientClosed) {
        client.close(
          sendableCloseCode(code, 1011),
          closeReason(reason.toString() || "upstream closed"),
        );
      }
    });

    upstream.on("error", (err: Error) => {
      warn(`${tag} upstream error: ${err.message}`);
      clearInterval(keepalive);
      tunnel?.close();
      if (!clientClosed) client.close(1011, closeReason(`upstream error: ${err.message}`));
    });
  } catch (err) {
    const message =
      k8sStatusCode(err) === 404 ? `AgentRun ${runName} not found` : errorMessage(err);
    warn(`${tag} failed to reach ACP endpoint: ${message}`);
    tunnel?.close();
    if (!clientClosed) client.close(1011, closeReason(message));
  }
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // No promise .catch protects this listener — a throw here (malformed
  // target, bad percent-encoding) would kill the process and with it every
  // in-flight ACP bridge. Both hazards answer 400 instead.
  const pathname = safePathname(req.url);
  const match = pathname && /^\/api\/agentruns\/([^/]+)\/acp$/.exec(pathname);
  if (pathname === undefined) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!match) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  let runName: string;
  try {
    runName = decodeURIComponent(match[1]);
  } catch {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  // Always accept the upgrade first so failures surface to the browser as a
  // close frame (1011 + reason) instead of an opaque handshake error.
  wss.handleUpgrade(req, socket, head, (client) => {
    void bridgeAcp(client, runName);
  });
});

server.listen(PORT, HOST, () => {
  log(`SHIM API v1 listening on http://${HOST}:${PORT} (namespace=${NAMESPACE}, acp-dial=${ACP_DIAL})`);
  log(
    `routes: GET /healthz | GET /api/applications | GET /api/images | POST /api/defaults | GET|POST /api/{agents,agentplaybooks,skillcards,skillcollections} | GET|PUT|DELETE /api/{agents,agentplaybooks,skillcards,skillcollections}/:name | GET /api/llmproviders[/:name] | GET|POST /api/agentruns | GET|DELETE /api/agentruns/:name | WS /api/agentruns/:name/acp | GET|POST /api/agentplaybookruns | GET|DELETE /api/agentplaybookruns/:name`,
  );
});

process.on("SIGINT", () => {
  log("shutting down");
  wss.clients.forEach((c) => c.close(1001, "hub-shim shutting down"));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
});
