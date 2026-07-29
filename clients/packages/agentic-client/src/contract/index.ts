/**
 * Contract types + helpers for the konveyor.io/v1alpha1 AgentRun surface.
 *
 * Source of truth: github.com/konveyor/agentic-controller api/v1alpha1/*.go
 * (the REAL controller, PR #4 era). Everything here is browser-safe: no
 * node builtins, no kube client — transports live elsewhere (see
 * ../transport-shim for the hub-shim HTTP transport).
 *
 * Verified controller facts encoded here:
 * - Sandbox pod name == status.sandboxName EXACTLY (real controller:
 *   sandboxName == run name). Never string-munge run names.
 * - ACP key Secret is named via status.secretKeyRef.name; the data key is
 *   "secret-key" (real controller) or "ACP_SECRET_KEY" (legacy simulator).
 * - ACP server: pod port 4000, path /acp, X-Secret-Key header auth.
 * - AgentRun spec is IMMUTABLE after create — delete+recreate, never patch.
 * - The migration-harness (PR #53 era) is Konveyor-aware: it pulls the
 *   application's repo, decrypted git identity, and analysis from the Hub
 *   itself, keyed by env vars on the run spec (see RUN_ENV). It hard-requires
 *   RUN_ENV.TARGET_BRANCH and a "primary"-role model selection, and fails
 *   fatally when the Agent mounts zero skills.
 */

// ---------------------------------------------------------------- k8s meta

export interface ObjectMeta {
  name?: string;
  generateName?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  uid?: string;
  resourceVersion?: string;
  creationTimestamp?: string;
}

export interface Condition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  observedGeneration?: number;
}

/** Browser-safe mirror of corev1.EnvVar (valueFrom left opaque on purpose). */
export interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: unknown;
}

/** Browser-safe mirror of corev1.EnvFromSource. */
export interface EnvFromSource {
  configMapRef?: { name: string; optional?: boolean };
  secretRef?: { name: string; optional?: boolean };
  prefix?: string;
}

// ---------------------------------------------------------------- AgentRun

export type AgentRunPhase = "Pending" | "Running" | "Succeeded" | "Failed";

export interface AgentRunParam {
  /** Matches an Agent param declaration; injected as KONVEYOR_PARAM_<NAME>. */
  name: string;
  value: string;
}

export interface AgentRunModelSelection {
  role: string;
  provider: string;
  model: string;
}

export interface AgentRunSpec {
  /** Name of the Agent CR to execute. Immutable (whole-spec CEL rule). */
  agentRef: string;
  params?: AgentRunParam[];
  /** Task-specific instructions, composed with the Agent's standing prompt. */
  instructions?: string;
  models?: AgentRunModelSelection[];
  /**
   * Pod env passthrough. The Konveyor platform rides the harness's Hub
   * coordinates and target branch here (RUN_ENV) — never as spec fields,
   * keeping the CRD platform-neutral.
   */
  env?: EnvVar[];
  /** Pod envFrom passthrough (LLM-provider credential Secrets etc.). */
  envFrom?: EnvFromSource[];
}

export interface AgentRunStatus {
  phase?: AgentRunPhase;
  observedGeneration?: number;
  /**
   * Name of the Sandbox CR created for this run. The backing pod has this
   * EXACT name — resolve the pod by name (works against every controller
   * build; the konveyor.io/agentrun pod label exists only since #34 and is
   * a fallback, not the primary mechanism).
   */
  sandboxName?: string;
  startTime?: string;
  completionTime?: string;
  /** Wall-clock duration of the run in seconds. */
  duration?: number;
  /** Secret holding the ACP auth key (X-Secret-Key header value). */
  secretKeyRef?: { name: string };
  conditions?: Condition[];
}

export interface AgentRun {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: AgentRunSpec;
  status?: AgentRunStatus;
}

// ------------------------------------------------------------- playbooks

/** Label keys the playbook-run controller stamps on stage AgentRuns. */
export const PLAYBOOK_RUN_LABEL = "konveyor.io/agentplaybookrun";
export const PLAYBOOK_STAGE_LABEL = "konveyor.io/stage";

/** One stage of an AgentPlaybook: an Agent plus stage instructions. */
export interface AgentPlaybookStage {
  /**
   * Stage name. Used in labels on the stage's AgentRun, so the CRD requires
   * a label-safe value: lowercase alphanumerics/hyphens/dots, max 63 chars
   * (STAGE_NAME_PATTERN), unique within the playbook.
   */
  name: string;
  agentRef: string;
  instructions?: string;
}

/** CRD pattern for AgentPlaybookStage.name (label-safe, ≤63 chars). */
export const STAGE_NAME_PATTERN = /^[a-z0-9]([a-z0-9\-.]*[a-z0-9])?$/;

export interface AgentPlaybookSpec {
  /**
   * High-level guide injected into every stage as the
   * KONVEYOR_PLAYBOOK_INSTRUCTIONS env var, composed into the prompt
   * between the Agent's standing prompt and the mounted skills.
   */
  guide?: string;
  /**
   * Ordered stages; executed sequentially on a shared target branch
   * (CRD: min 1). Stages chain through committed artifacts on that branch
   * (plan commits PLAN.md, execute reads it) — one stage's chat output is
   * never fed into the next stage's prompt.
   */
  stages: AgentPlaybookStage[];
}

/** An AgentPlaybook CR — a reusable template; creating one executes nothing. */
export interface AgentPlaybook {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: AgentPlaybookSpec;
  status?: { observedGeneration?: number; conditions?: Condition[] };
}

/** Per-stage status of an AgentPlaybookRun (status.stages[]). */
export interface AgentPlaybookRunStage {
  name: string;
  /** Reuses the AgentRun phase enum. */
  phase: AgentRunPhase;
  /**
   * Name of the stage's AgentRun once created. Always read this (or the
   * labels) rather than recomputing "<run>-<stage>" — names are
   * hash-truncated past 63 chars.
   */
  agentRunName?: string;
}

export interface AgentPlaybookRunStatus {
  phase?: AgentRunPhase;
  observedGeneration?: number;
  /**
   * Stage currently executing. Cleared only when the run Succeeds — on a
   * Failed run it stays set to the stage that failed. Use phase (or
   * completionTime) as the terminal test, never this field.
   */
  currentStage?: string;
  stages?: AgentPlaybookRunStage[];
  startTime?: string;
  completionTime?: string;
  /**
   * NOTE: unlike AgentRunStatus there is no duration field — compute it
   * from startTime/completionTime. Ready=False reason=StageRunning is the
   * NORMAL healthy state while executing, not an error.
   */
  conditions?: Condition[];
}

export interface AgentPlaybookRun {
  apiVersion: string;
  kind: "AgentPlaybookRun";
  metadata: ObjectMeta;
  spec: {
    playbookRef: string;
    params?: { name: string; value: string }[];
    models?: { role: string; provider: string; model: string }[];
    /** Forwarded verbatim to every stage's AgentRun (Hub coords ride here). */
    env?: EnvVar[];
    /** Forwarded verbatim to every stage's AgentRun. */
    envFrom?: EnvFromSource[];
  };
  status?: AgentPlaybookRunStatus;
}

// ------------------------------------------------------------------- Agent

export type AgentParamType = "string" | "number" | "boolean";

export interface AgentParam {
  name: string;
  type?: AgentParamType;
  description?: string;
  default?: string;
  required?: boolean;
}

export interface AgentResourceSpec {
  /** Container image carrying the agent runtime (ACP server on :4000/acp). */
  image: string;
  /** Standing instructions, composed with AgentRun.spec.instructions. */
  prompt?: string;
  params?: AgentParam[];
  providers?: { ref: string }[];
  /**
   * SkillCard refs resolved to OCI image volumes mounted at
   * /opt/skills/<name>. The migration-harness fails fatally when zero
   * skills are mounted — treat an empty skill set as a misconfigured
   * migration agent (only fixtures like the mock harness run without).
   */
  skillCards?: { ref: string }[];
  /** SkillCollection refs; members mount alongside skillCards, deduped by name. */
  skillCollections?: { ref: string }[];
}

/** An Agent CR ("AgentResource" to avoid clashing with UI "agent" concepts). */
export interface AgentResource {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: AgentResourceSpec;
  status?: { observedGeneration?: number; conditions?: Condition[] };
}

/** CRD pattern for AgentParam.name (uppercased into KONVEYOR_PARAM_<NAME>). */
export const PARAM_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// -------------------------------------------------------------- SkillCard

/**
 * "skill" is on-demand (name/description loaded at startup, content on
 * invocation); "rule" is always-loaded into every turn's context.
 */
export type SkillCardType = "skill" | "rule";

/**
 * SkillCard content source: exactly ONE of image | source | inline (CRD CEL
 * rule). Image-ref cards are the only kind the controller resolves today —
 * git-source and inline cards reconcile to NotReady ("Phase 3"), so
 * authoring UIs should create image cards only.
 */
export interface SkillCardSpec {
  /** OCI image reference for a pre-built skill artifact. */
  image?: string;
  /** Git URL of a skill directory (controller support: Phase 3, NotReady). */
  source?: string;
  /** Raw SKILL.md markdown (controller support: Phase 3, NotReady). */
  inline?: string;
  displayName?: string;
  version?: string;
  description?: string;
  /** Defaults to "skill" server-side. */
  type?: SkillCardType;
  /** Categorization tags (CRD: a set — unique values). */
  tags?: string[];
}

export interface SkillCard {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: SkillCardSpec;
  status?: {
    observedGeneration?: number;
    /** OCI ref the controller resolved; what actually mounts at /opt/skills. */
    resolvedImage?: string;
    conditions?: Condition[];
  };
}

// -------------------------------------------------------- SkillCollection

/**
 * One member of a SkillCollection: exactly ONE of skillCardRef | image |
 * source (CRD CEL rule). Members with a direct image need no SkillCard CR;
 * git-source members spawn child SkillCards that are NotReady today.
 */
export interface SkillCollectionSkillRef {
  /** Local name for this skill within the collection (unique, min 1 char). */
  name: string;
  skillCardRef?: string;
  image?: string;
  source?: string;
}

export interface SkillCollectionSpec {
  version?: string;
  /** Ordered members (CRD: min 1). */
  skills: SkillCollectionSkillRef[];
}

export interface SkillCollection {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: SkillCollectionSpec;
  status?: { observedGeneration?: number; conditions?: Condition[] };
}

// ------------------------------------------------------------ LLMProvider

export interface LLMProviderModel {
  name: string;
  contextWindow: number;
  /** e.g. "primary" — the tier the platform's default model policy prefers. */
  tier?: string;
}

/**
 * Browser-safe mirror of the LLMProvider CR. NOTE: the migration-harness
 * maps the CR NAME to a goose provider id verbatim (lowercased, "-" → "_"),
 * so providers must be named like goose provider ids (e.g. "aws-bedrock").
 */
export interface LLMProvider {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec: {
    endpoint: string;
    /** key omitted = keyless: the whole Secret reaches the sandbox (SigV4). */
    credentialRef: { secretName: string; key?: string };
    models: LLMProviderModel[];
  };
  status?: {
    observedGeneration?: number;
    connectionVerified?: boolean;
    discoveredModels?: string[];
    conditions?: Condition[];
  };
}

// ------------------------------------------------------------ ACP endpoint

/**
 * Secret data keys the ACP key may live under, tried in order: the real
 * agentic-controller writes "secret-key"; the legacy dev simulator wrote
 * "ACP_SECRET_KEY". If neither is present but the secret holds exactly one
 * entry, that sole entry is used.
 */
export const SECRET_DATA_KEYS = ["secret-key", "ACP_SECRET_KEY"] as const;

/** Port the sandbox pod's ACP server listens on. */
export const ACP_PORT = 4000;

/** HTTP/WebSocket path of the ACP server on the pod. */
export const ACP_PATH = "/acp";

/**
 * Resolves the ACP secret key from a k8s Secret's `.data` map (values are
 * base64-encoded, as returned by the apiserver). Tries SECRET_DATA_KEYS in
 * order, then falls back to the sole entry if exactly one key exists.
 * Returns the DECODED utf-8 key (the X-Secret-Key header value).
 */
export function resolveSecretKeyFromData(data: Record<string, string>): string {
  const present = Object.keys(data);
  for (const key of SECRET_DATA_KEYS) {
    const value = data[key];
    if (value !== undefined) {
      return decodeBase64Utf8(value, key);
    }
  }
  if (present.length === 1) {
    const sole = present[0] as string;
    return decodeBase64Utf8(data[sole] as string, sole);
  }
  throw new Error(
    `No ACP secret key found in secret data: looked for ${SECRET_DATA_KEYS.join(", ")}, ` +
      (present.length === 0
        ? "but the secret has no data entries."
        : `and the secret has ${present.length} entries (${present.join(", ")}) so the ` +
          "sole-entry fallback does not apply.") +
      " Expected the AgentRun's <sandboxName>-acp-key secret.",
  );
}

function decodeBase64Utf8(b64: string, keyName: string): string {
  let binary: string;
  try {
    binary = atob(b64.replace(/\s+/g, ""));
  } catch (err) {
    throw new Error(
      `Secret data key "${keyName}" is not valid base64: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// --------------------------------------------------- harness run injection

/**
 * Env var names the Konveyor platform injects on run specs (spec.env) so the
 * Konveyor-aware harness can pull everything else itself: it fetches the
 * application's repo URL, decrypted git identity, and analysis from the Hub,
 * clones, strips credentials before the agent starts, and is the only thing
 * that pushes. These ride the CRD's generic env passthrough — they are NOT
 * spec fields, keeping the controller platform-neutral.
 */
export const RUN_ENV = {
  /** Hub REST base the harness dials (in-cluster service DNS, usually). */
  HUB_BASE_URL: "HUB_BASE_URL",
  /**
   * Bearer token for the harness's Hub API calls (application, git
   * identity, analysis). Optional only against an UNAUTHENTICATED Hub —
   * repo visibility is irrelevant, since even a public-repo run resolves
   * the application through the Hub first. Platforms should deliver it as
   * a Secret-backed valueFrom env var, never a plaintext value in the CR.
   */
  HUB_TOKEN: "HUB_TOKEN",
  /** Numeric Hub application id (the harness rejects non-numeric ids). */
  APP_ID: "APP_ID",
  /**
   * Branch the harness checks out and pushes to. Required, and must differ
   * from the application's source branch. Nothing in the system generates
   * it — the caller mints it (defaultTargetBranch). If origin/<branch>
   * already exists the harness continues it, which is how playbook stages
   * chain work on one branch.
   */
  TARGET_BRANCH: "TARGET_BRANCH",
} as const;

/** Prefix for platform-minted migration branches. */
export const TARGET_BRANCH_PREFIX = "konveyor/migration-";

/**
 * Default migration branch name, unique per second — the same shape the
 * upstream harness testbed mints. Callers may override with anything that
 * differs from the application's source branch.
 */
export function defaultTargetBranch(now: Date = new Date()): string {
  return `${TARGET_BRANCH_PREFIX}${Math.floor(now.getTime() / 1000)}`;
}

/**
 * Why a string is unusable as the harness's target branch, or undefined if
 * it looks fine. Shared by the shim's request validation and the create
 * forms so both sides reject the same shapes (git refname rules: control
 * chars and refname specials, "..", "@{", leading "-", dot/".lock"/empty
 * path components).
 */
export function invalidTargetBranchReason(branch: string): string | undefined {
  const b = branch.trim();
  if (!b) return "required";
  const badComponent = (c: string) => c === "" || c.startsWith(".") || c.endsWith(".lock");
  if (
    // eslint-disable-next-line no-control-regex -- git forbids control chars in refnames
    /[\x00-\x20~^:?*[\\\x7f]/.test(b) ||
    b.includes("..") ||
    b.includes("@{") ||
    b === "@" ||
    b.startsWith("-") ||
    b.endsWith(".") ||
    b.endsWith("/") ||
    b.split("/").some(badComponent)
  ) {
    return "not a valid git branch name";
  }
  return undefined;
}

// ------------------------------------------------- platform-resolved params

/**
 * Label marking Agents the Konveyor platform (Hub/UI) knows how to drive.
 * Platform agent lists filter on this; unlabeled Agents stay invisible to
 * Konveyor UIs without affecting other consumers of the generic CRD.
 */
export const MANAGED_LABEL = "konveyor.io/managed";

/**
 * Agent annotation mapping param name -> source identifier, e.g.
 * {"repository": "konveyor.io/application-repository-url"}. A param with a
 * source is resolved by the platform at run creation; params without one are
 * supplied by the caller. Source identifiers are namespaced strings, NOT a
 * CRD enum — consumers that do not recognize a value MUST fail open and
 * treat the param as caller-supplied.
 *
 * @deprecated RETIRED for the Konveyor path (2026-07): the Konveyor-aware
 * harness pulls repo/branch/credentials from the Hub itself, keyed by
 * RUN_ENV injection — the platform no longer resolves these annotations at
 * create time. The vocabulary remains documented for callers that resolve
 * values themselves (issue-22 open question 1).
 */
export const PARAM_SOURCES_ANNOTATION = "konveyor.io/param-sources";

/**
 * Agent annotation mapping credential name -> source identifier, e.g.
 * {"git": "konveyor.io/application-identity"}. Same contract as param
 * sources but resolves to a Secret the platform mounts via
 * AgentRun.spec.envFrom instead of a string param value.
 *
 * @deprecated RETIRED for the Konveyor path (2026-07) — see
 * PARAM_SOURCES_ANNOTATION. The harness fetches the decrypted identity from
 * the Hub in-pod and withholds it from the agent; no Secret bridge exists.
 */
export const CREDENTIAL_SOURCES_ANNOTATION = "konveyor.io/credential-sources";

/** Well-known source identifiers the prototype platform resolves. */
export const SOURCE_APPLICATION_REPOSITORY_URL = "konveyor.io/application-repository-url";
export const SOURCE_APPLICATION_REPOSITORY_BRANCH = "konveyor.io/application-repository-branch";
export const SOURCE_APPLICATION_IDENTITY = "konveyor.io/application-identity";

/**
 * Parses an Agent's param-sources (or credential-sources) annotation into a
 * name -> source map. Returns {} for a missing, malformed, or non-object
 * annotation — bad metadata must never break run creation (fail open).
 */
export function parseSourcesAnnotation(
  agent: Pick<AgentResource, "metadata"> | undefined,
  annotation: string = PARAM_SOURCES_ANNOTATION,
): Record<string, string> {
  const raw = agent?.metadata?.annotations?.[annotation];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, source] of Object.entries(parsed)) {
      if (typeof source === "string" && source.trim() !== "") out[name] = source;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A Konveyor application as the platform's application inventory exposes it.
 * Backed by real Konveyor Hub Application records (repository + linked
 * identities); the hub-shim reads Hub over HUB_URL and maps them here.
 */
export interface Application {
  id: string;
  name: string;
  repository?: { url: string; branch?: string };
  /**
   * The application's source-control credential as Hub holds it — a named
   * Identity in Hub's vault. Present when the app has a `source` identity.
   * Display-only: the harness fetches the DECRYPTED identity from the Hub
   * itself (in-pod, withheld from the agent) — no Secret ever materializes
   * platform-side.
   */
  identity?: { name: string };
}

// ---------------------------------------------------------- image catalog

/**
 * One entry in the platform's agent-image catalog: the upstream image
 * hierarchy (agent-base + per-language derivatives) plus whatever a site
 * adds. Backed by a managed ConfigMap (IMAGE_CATALOG_CONFIGMAP) so the
 * catalog is cluster data, not client code — an AgentImage CRD is the
 * upstream escalation if the ConfigMap proves insufficient.
 */
export interface AgentImage {
  /** Full image ref an Agent.spec.image can use verbatim. */
  image: string;
  displayName: string;
  /** Language toolchain the image bakes in; absent on the base image. */
  language?: string;
  /** What the image adds over its base. */
  notes?: string;
  /** Catalog-internal ref to the image this one derives from. */
  base?: string;
}

/** ConfigMap (in the shim's namespace) holding the agent-image catalog. */
export const IMAGE_CATALOG_CONFIGMAP = "agent-image-catalog";

/** Key inside the catalog ConfigMap whose value is a JSON AgentImage[]. */
export const IMAGE_CATALOG_KEY = "catalog.json";

// --------------------------------------------------------- seeded defaults

/** Outcome for one resource of a RunApi.loadDefaults seeding pass. */
export interface SeedResult {
  kind: string;
  name: string;
  /** "exists" means the resource was already there — seeding never updates. */
  status: "created" | "exists";
}

// ----------------------------------------------------------------- RunApi

/** Input for RunApi.createRun — params as a plain map, mapped by the transport. */
export interface CreateRunInput {
  agentRef: string;
  params?: Record<string, string>;
  instructions?: string;
  /**
   * Hub application this run works on. The platform injects the Hub
   * coordinates + APP_ID (+ TARGET_BRANCH) into spec.env; the harness pulls
   * repo, credentials, and analysis from the Hub itself. Must be a NUMERIC
   * Hub id — the harness rejects anything else. Omit only for agents that
   * run without an application (e.g. the mock fixture).
   */
  applicationRef?: string;
  /**
   * Branch the harness creates (or continues) and pushes migration work to.
   * Only meaningful with applicationRef. Defaults to defaultTargetBranch();
   * must differ from the application's source branch.
   */
  targetBranch?: string;
  /**
   * Explicit "primary"-role model selection. Omitted: the platform's default
   * policy picks the agent's FIRST declared provider and that provider's
   * primary-tier model (else its first). Supplied: the provider must be
   * among the agent's declared providers and the model declared on the
   * LLMProvider CR — the shim rejects anything else (400).
   */
  model?: { provider: string; model: string };
}

/**
 * Input for RunApi.createPlaybookRun. Deliberately NO instructions field:
 * AgentPlaybookRun.spec has none — stage instructions come from the
 * playbook. Params forward wholesale to every stage, and the injected env
 * (Hub coords + TARGET_BRANCH) is forwarded verbatim to every stage's
 * AgentRun — one shared branch is how stages chain work.
 */
export interface CreatePlaybookRunInput {
  playbookRef: string;
  params?: Record<string, string>;
  /** Same semantics as CreateRunInput.applicationRef, applied to every stage. */
  applicationRef?: string;
  /** Same semantics as CreateRunInput.targetBranch — one branch, all stages. */
  targetBranch?: string;
  /**
   * Same semantics as CreateRunInput.model, applied to EVERY stage (there
   * are no per-stage overrides): the provider must be declared by every
   * stage Agent and the model by the LLMProvider CR, else 400.
   */
  model?: { provider: string; model: string };
}

/**
 * Transport-agnostic API over Agents + AgentRuns. Implemented today by
 * ShimClient (hub-shim HTTP); a future Konveyor Hub proxy exposes the same
 * shape. NOTE: AgentRun spec is immutable — there is deliberately no update.
 */
export interface RunApi {
  listAgents(): Promise<AgentResource[]>;
  /** Get one Agent by name — unfiltered, so stage agents without the
   * managed label are still introspectable for their declared params. */
  getAgent(name: string): Promise<AgentResource>;
  /** Platform application inventory (for resolving sourced params). */
  listApplications(): Promise<Application[]>;
  listRuns(): Promise<AgentRun[]>;
  listPlaybooks(): Promise<AgentPlaybook[]>;
  listPlaybookRuns(): Promise<AgentPlaybookRun[]>;
  getPlaybookRun(name: string): Promise<AgentPlaybookRun>;
  createRun(input: CreateRunInput): Promise<AgentRun>;
  /** Spec is whole-spec immutable — delete+recreate, never update. */
  createPlaybookRun(input: CreatePlaybookRunInput): Promise<AgentPlaybookRun>;
  getRun(name: string): Promise<AgentRun>;
  deleteRun(name: string): Promise<void>;
  /** Cascades: stage AgentRuns are owner-referenced and GC'd. */
  deletePlaybookRun(name: string): Promise<void>;
  /** The platform's agent-image catalog (source for image pickers). */
  listImages(): Promise<AgentImage[]>;
  /**
   * Seeds the default managed resource set (provider, stage agents, skill
   * cards, playbooks, image catalog). Idempotent: existing resources are
   * left untouched and reported as "exists".
   */
  loadDefaults(): Promise<SeedResult[]>;
}

// -------------------------------------------------------------- CatalogApi

/**
 * Management surface over the CRs a Konveyor UI authors: Agents, SkillCards,
 * SkillCollections, AgentPlaybooks (+ read-only LLMProviders for pickers).
 * Implemented by ShimClient; the write routes are the R1 proposal for the
 * Konveyor Hub, exactly as the run routes were (issue-22 contract).
 *
 * Semantics (thin k8s passthrough — no domain logic, per the issue-22
 * placement decision):
 * - create(name, spec): named create; the platform stamps
 *   `konveyor.io/managed=true` (MANAGED_LABEL). 409 when the name exists.
 * - update(name, spec): spec replacement on the existing object; metadata is
 *   preserved and the managed label stamped (editing adopts an unlabeled
 *   resource into the platform). 404 when absent, 409 on write conflict.
 * - delete(name): 204 | 404. No reference checking — the apiserver and
 *   controllers own integrity; UIs should surface references before
 *   offering delete.
 * - CRD schema/CEL violations surface as 4xx with the apiserver's message —
 *   the platform does not duplicate schema validation.
 * - Lists are filtered to `konveyor.io/managed=true`; get-by-name is never
 *   filtered. LLMProvider lists are NOT filtered: providers are
 *   cluster-admin-owned and this surface never creates them.
 */
export interface CatalogApi {
  listProviders(): Promise<LLMProvider[]>;
  getProvider(name: string): Promise<LLMProvider>;

  listSkillCards(): Promise<SkillCard[]>;
  getSkillCard(name: string): Promise<SkillCard>;
  createSkillCard(name: string, spec: SkillCardSpec): Promise<SkillCard>;
  updateSkillCard(name: string, spec: SkillCardSpec): Promise<SkillCard>;
  deleteSkillCard(name: string): Promise<void>;

  listSkillCollections(): Promise<SkillCollection[]>;
  getSkillCollection(name: string): Promise<SkillCollection>;
  createSkillCollection(name: string, spec: SkillCollectionSpec): Promise<SkillCollection>;
  updateSkillCollection(name: string, spec: SkillCollectionSpec): Promise<SkillCollection>;
  deleteSkillCollection(name: string): Promise<void>;

  createAgent(name: string, spec: AgentResourceSpec): Promise<AgentResource>;
  updateAgent(name: string, spec: AgentResourceSpec): Promise<AgentResource>;
  deleteAgent(name: string): Promise<void>;

  getPlaybook(name: string): Promise<AgentPlaybook>;
  createPlaybook(name: string, spec: AgentPlaybookSpec): Promise<AgentPlaybook>;
  updatePlaybook(name: string, spec: AgentPlaybookSpec): Promise<AgentPlaybook>;
  deletePlaybook(name: string): Promise<void>;
}

/**
 * K8s object-name shape (DNS-1123 subdomain) for named creates. The
 * apiserver enforces this anyway; forms use it for early feedback.
 */
export const RESOURCE_NAME_PATTERN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
export const RESOURCE_NAME_MAX = 253;

// ---------------------------------------------------------------- waiting

/** True when the run can no longer make progress (Succeeded or Failed). */
export function isTerminalPhase(p?: string): boolean {
  return p === "Succeeded" || p === "Failed";
}

export interface WaitForRunningOptions {
  /** Overall deadline. Default 120_000 ms. */
  timeoutMs?: number;
  /** Poll interval. Default 1_000 ms. */
  pollMs?: number;
  signal?: AbortSignal;
  /** Progress callback, invoked once per poll with the observed phase. */
  onPhase?: (phase: string, elapsedMs: number) => void;
}

/**
 * Polls the run until it is connectable: phase == Running AND
 * status.sandboxName AND status.secretKeyRef are set. Rejects on phase ==
 * Failed (with condition messages), on timeout (with an actionable
 * message), or when opts.signal aborts.
 */
export async function waitForRunning(
  api: RunApi,
  name: string,
  opts?: WaitForRunningOptions,
): Promise<AgentRun> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const pollMs = opts?.pollMs ?? 1_000;
  const started = Date.now();
  for (;;) {
    opts?.signal?.throwIfAborted();
    const run = await api.getRun(name);
    const phase = run.status?.phase ?? "Pending";
    const elapsed = Date.now() - started;
    opts?.onPhase?.(phase, elapsed);
    if (phase === "Failed") {
      const detail = (run.status?.conditions ?? [])
        .map((c) => c.message)
        .filter(Boolean)
        .join("; ");
      throw new Error(`AgentRun ${name} failed${detail ? `: ${detail}` : ""}`);
    }
    if (phase === "Running" && run.status?.sandboxName && run.status?.secretKeyRef?.name) {
      return run;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for AgentRun ${name} to reach Running with a ` +
          `sandbox and ACP key (last phase=${phase}, sandboxName=${run.status?.sandboxName ?? "unset"}, ` +
          `secretKeyRef=${run.status?.secretKeyRef?.name ?? "unset"}). The sandbox may still be ` +
          `pulling its image or the controller may not be reconciling — check ` +
          `'kubectl describe agentrun ${name}' and the agentic-controller logs.`,
      );
    }
    await sleep(pollMs, opts?.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
