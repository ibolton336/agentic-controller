/**
 * ShimClient — RunApi over the hub-shim HTTP API (fetch-based, no node
 * builtins; works in browsers and node >= 18).
 *
 * SHIM HTTP API v1 (the future Konveyor Hub proxy is expected to expose the
 * same shape). Full route table + semantics: docs/adr/0004.
 *   GET    /api/applications         -> Application[] (platform inventory)
 *   GET    /api/agents               -> AgentResource[] (konveyor.io/managed=true)
 *   GET    /api/agentruns            -> AgentRun[]
 *   POST   /api/agentruns            -> 201 AgentRun (applicationRef resolves
 *                                       sourced params/credentials, ADR 0005)
 *   GET    /api/agentruns/:name      -> AgentRun | 404
 *   DELETE /api/agentruns/:name      -> 204
 *   WS     /api/agentruns/:name/acp  -> ACP tunnel to the sandbox pod
 *                                       (the shim injects X-Secret-Key)
 *   GET    /api/agentplaybooks       -> AgentPlaybook[]
 *   GET    /api/agentplaybookruns    -> AgentPlaybookRun[]
 *   POST   /api/agentplaybookruns    -> 201 AgentPlaybookRun (params/models
 *                                       resolved vs the union of stage Agents)
 *   GET    /api/agentplaybookruns/:name    -> AgentPlaybookRun | 404
 *   DELETE /api/agentplaybookruns/:name    -> 204 (cascades to stage runs)
 *   GET    /api/images               -> AgentImage[] (agent-image catalog)
 *   POST   /api/defaults             -> SeedResult[] (seed default set,
 *                                       idempotent create-only)
 *
 * Catalog management routes (CatalogApi — the Hub R1 write proposal), all
 * four of agents | skillcards | skillcollections | agentplaybooks:
 *   GET    /api/<plural>             -> 200 CR[] (konveyor.io/managed=true)
 *   GET    /api/<plural>/:name       -> 200 CR | 404 (unfiltered)
 *   POST   /api/<plural>             -> 201 CR   body {name, spec};
 *                                       managed label stamped; 409 exists
 *   PUT    /api/<plural>/:name       -> 200 CR   body {spec}; spec replaced,
 *                                       metadata kept, label stamped;
 *                                       404 absent, 409 conflict
 *   DELETE /api/<plural>/:name       -> 204 | 404
 *   GET    /api/llmproviders[/:name] -> read-only (list unfiltered)
 */
import type {
  AgentImage,
  AgentPlaybook,
  AgentPlaybookRun,
  AgentPlaybookSpec,
  AgentResource,
  AgentResourceSpec,
  AgentRun,
  Application,
  CatalogApi,
  CreatePlaybookRunInput,
  CreateRunInput,
  LLMProvider,
  RunApi,
  SeedResult,
  SkillCard,
  SkillCardSpec,
  SkillCollection,
  SkillCollectionSpec,
} from "../contract/index.js";

/** Abort any REST call that hasn't answered within this budget. */
const REQUEST_TIMEOUT_MS = 30_000;

export class ShimClient implements RunApi, CatalogApi {
  /** Normalized base URL, no trailing slash (e.g. http://127.0.0.1:7080). */
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    // Validate eagerly so a bad base fails at construction, not first call.
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`ShimClient: baseUrl must be http(s), got ${parsed.protocol}//`);
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  listAgents(): Promise<AgentResource[]> {
    return this.json<AgentResource[]>("GET", "/api/agents");
  }

  getAgent(name: string): Promise<AgentResource> {
    return this.json<AgentResource>("GET", `/api/agents/${encodeURIComponent(name)}`);
  }

  listApplications(): Promise<Application[]> {
    return this.json<Application[]>("GET", "/api/applications");
  }

  /**
   * Like listApplications, but also returns where the inventory came from
   * (from the X-Inventory-* response headers): "hub" with the endpoint, or
   * "stub" when Hub was unreachable. Lets a UI show the data is live, not
   * hardcoded. Falls back to source "unknown" if headers are absent (e.g. a
   * Hub proxy that doesn't set them).
   */
  async listApplicationsWithSource(): Promise<{
    source: "hub" | "stub" | "unknown";
    endpoint: string;
    applications: Application[];
  }> {
    const res = await this.send("GET", "/api/applications");
    const applications = (await res.json()) as Application[];
    const header = res.headers.get("X-Inventory-Source");
    const source = header === "hub" || header === "stub" ? header : "unknown";
    return { source, endpoint: res.headers.get("X-Inventory-Endpoint") ?? "", applications };
  }

  listRuns(): Promise<AgentRun[]> {
    return this.json<AgentRun[]>("GET", "/api/agentruns");
  }

  createRun(input: CreateRunInput): Promise<AgentRun> {
    return this.json<AgentRun>("POST", "/api/agentruns", input);
  }

  getRun(name: string): Promise<AgentRun> {
    return this.json<AgentRun>("GET", `/api/agentruns/${encodeURIComponent(name)}`);
  }

  listPlaybooks(): Promise<AgentPlaybook[]> {
    return this.json<AgentPlaybook[]>("GET", "/api/agentplaybooks");
  }

  listPlaybookRuns(): Promise<AgentPlaybookRun[]> {
    return this.json<AgentPlaybookRun[]>("GET", "/api/agentplaybookruns");
  }

  getPlaybookRun(name: string): Promise<AgentPlaybookRun> {
    return this.json<AgentPlaybookRun>("GET", `/api/agentplaybookruns/${encodeURIComponent(name)}`);
  }

  createPlaybookRun(input: CreatePlaybookRunInput): Promise<AgentPlaybookRun> {
    return this.json<AgentPlaybookRun>("POST", "/api/agentplaybookruns", input);
  }

  async deletePlaybookRun(name: string): Promise<void> {
    await this.send("DELETE", `/api/agentplaybookruns/${encodeURIComponent(name)}`);
  }

  async deleteRun(name: string): Promise<void> {
    await this.send("DELETE", `/api/agentruns/${encodeURIComponent(name)}`);
  }

  listImages(): Promise<AgentImage[]> {
    return this.json<AgentImage[]>("GET", "/api/images");
  }

  loadDefaults(): Promise<SeedResult[]> {
    return this.json<SeedResult[]>("POST", "/api/defaults");
  }

  // ---------------------------------------------------- CatalogApi (reads)

  listProviders(): Promise<LLMProvider[]> {
    return this.json<LLMProvider[]>("GET", "/api/llmproviders");
  }

  getProvider(name: string): Promise<LLMProvider> {
    return this.json<LLMProvider>("GET", `/api/llmproviders/${encodeURIComponent(name)}`);
  }

  listSkillCards(): Promise<SkillCard[]> {
    return this.json<SkillCard[]>("GET", "/api/skillcards");
  }

  getSkillCard(name: string): Promise<SkillCard> {
    return this.json<SkillCard>("GET", `/api/skillcards/${encodeURIComponent(name)}`);
  }

  listSkillCollections(): Promise<SkillCollection[]> {
    return this.json<SkillCollection[]>("GET", "/api/skillcollections");
  }

  getSkillCollection(name: string): Promise<SkillCollection> {
    return this.json<SkillCollection>("GET", `/api/skillcollections/${encodeURIComponent(name)}`);
  }

  getPlaybook(name: string): Promise<AgentPlaybook> {
    return this.json<AgentPlaybook>("GET", `/api/agentplaybooks/${encodeURIComponent(name)}`);
  }

  // --------------------------------------------------- CatalogApi (writes)

  createAgent(name: string, spec: AgentResourceSpec): Promise<AgentResource> {
    return this.json<AgentResource>("POST", "/api/agents", { name, spec });
  }

  updateAgent(name: string, spec: AgentResourceSpec): Promise<AgentResource> {
    return this.json<AgentResource>("PUT", `/api/agents/${encodeURIComponent(name)}`, { spec });
  }

  async deleteAgent(name: string): Promise<void> {
    await this.send("DELETE", `/api/agents/${encodeURIComponent(name)}`);
  }

  createSkillCard(name: string, spec: SkillCardSpec): Promise<SkillCard> {
    return this.json<SkillCard>("POST", "/api/skillcards", { name, spec });
  }

  updateSkillCard(name: string, spec: SkillCardSpec): Promise<SkillCard> {
    return this.json<SkillCard>("PUT", `/api/skillcards/${encodeURIComponent(name)}`, { spec });
  }

  async deleteSkillCard(name: string): Promise<void> {
    await this.send("DELETE", `/api/skillcards/${encodeURIComponent(name)}`);
  }

  createSkillCollection(name: string, spec: SkillCollectionSpec): Promise<SkillCollection> {
    return this.json<SkillCollection>("POST", "/api/skillcollections", { name, spec });
  }

  updateSkillCollection(name: string, spec: SkillCollectionSpec): Promise<SkillCollection> {
    return this.json<SkillCollection>(
      "PUT",
      `/api/skillcollections/${encodeURIComponent(name)}`,
      { spec },
    );
  }

  async deleteSkillCollection(name: string): Promise<void> {
    await this.send("DELETE", `/api/skillcollections/${encodeURIComponent(name)}`);
  }

  createPlaybook(name: string, spec: AgentPlaybookSpec): Promise<AgentPlaybook> {
    return this.json<AgentPlaybook>("POST", "/api/agentplaybooks", { name, spec });
  }

  updatePlaybook(name: string, spec: AgentPlaybookSpec): Promise<AgentPlaybook> {
    return this.json<AgentPlaybook>("PUT", `/api/agentplaybooks/${encodeURIComponent(name)}`, {
      spec,
    });
  }

  async deletePlaybook(name: string): Promise<void> {
    await this.send("DELETE", `/api/agentplaybooks/${encodeURIComponent(name)}`);
  }

  /**
   * ws(s):// URL of the shim's ACP tunnel for a run, derived from baseUrl
   * (http -> ws, https -> wss; any base path prefix is preserved). Pass to
   * AcpSession.connect — no secretKey needed, the shim injects it upstream.
   */
  acpUrl(runName: string): string {
    const u = new URL(this.baseUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    const prefix = u.pathname.replace(/\/+$/, "");
    u.pathname = `${prefix}/api/agentruns/${encodeURIComponent(runName)}/acp`;
    u.search = "";
    u.hash = "";
    return u.toString();
  }

  // ------------------------------------------------------------ internals

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const url = this.baseUrl + path;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // fetch has no built-in timeout; without this a stalled shim or a
        // network partition hangs every RunApi call forever.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `${method} ${url} failed: ${err instanceof Error ? err.message : String(err)} — is the hub-shim running?`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `${method} ${url} failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ""}`,
      );
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    return (await res.json()) as T;
  }
}
