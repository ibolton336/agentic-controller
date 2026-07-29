/**
 * Shared pieces of the create-run and create-playbook-run modals: the
 * application-inventory hook with provenance, and the preview of what the
 * Konveyor-aware harness pulls from the Hub for a selected application.
 *
 * The ADR 0005 param/credential-source machinery that used to live here is
 * RETIRED for the platform path: the platform no longer resolves repo/branch
 * params or bridges identity Secrets at create time. The harness pulls all
 * of that from the Hub itself, in-pod, keyed by the injected RUN_ENV vars —
 * and withholds the git credentials from the agent.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  FormSelect,
  FormSelectOption,
  Label,
  TextInput,
} from "@patternfly/react-core";
import type {
  AgentImage,
  AgentParam,
  AgentResource,
  Application,
  Condition,
  EnvVar,
  LLMProvider,
} from "@konveyor/agentic-client/contract";
import { RUN_ENV } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, truncate } from "../format";

export function paramHelperText(p: AgentParam): string {
  const parts: string[] = [];
  if (p.description) parts.push(p.description);
  if (p.type && p.type !== "string") parts.push(`type: ${p.type}`);
  if (p.default) parts.push(`default: ${p.default}`);
  return parts.join(" — ");
}

/** Declared skill refs on an Agent (skillCards + skillCollections). */
export function skillCount(agent: AgentResource | undefined): number {
  return (
    (agent?.spec.skillCards?.length ?? 0) + (agent?.spec.skillCollections?.length ?? 0)
  );
}

// ------------------------------------------------------ agent-image catalog

/**
 * The platform's agent-image catalog (GET /api/images). Load failures are
 * swallowed to [] — the catalog only ever annotates; nothing may block on it.
 */
export function useImageCatalog(api: ShimClient): AgentImage[] {
  const [catalog, setCatalog] = useState<AgentImage[]>([]);
  useEffect(() => {
    let disposed = false;
    api
      .listImages()
      .then((images) => {
        if (!disposed) setCatalog(images);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [api]);
  return catalog;
}

/**
 * An Agent's image, annotated from the catalog when the ref matches —
 * "which toolchain does this agent run on" at a glance in the launcher.
 */
export function AgentImageLine({
  image,
  catalog,
}: {
  image: string | undefined;
  catalog: AgentImage[];
}) {
  if (!image) return null;
  const entry = catalog.find((e) => e.image === image);
  return (
    <span className="agent-image-line">
      image: <code>{truncate(image, 60)}</code>
      {entry && (
        <span className="agent-image-notes">
          {" "}
          — {entry.displayName}
          {entry.notes ? ` · ${entry.notes}` : ""}
        </span>
      )}
    </span>
  );
}

// -------------------------------------------------- application inventory

export interface ApplicationInventory {
  applications: Application[];
  /** Load failure — must not block agents that run without an application. */
  error: string | null;
  source: "hub" | "stub" | "unknown" | null;
  endpoint: string;
  reloading: boolean;
  reload: () => Promise<void>;
}

/**
 * The platform's application inventory with provenance. Re-fetch on demand
 * via reload() — register an application in Hub and click Refresh to watch
 * it appear, proving the list is live, not baked in.
 */
export function useApplicationInventory(api: ShimClient): ApplicationInventory {
  const [applications, setApplications] = useState<Application[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"hub" | "stub" | "unknown" | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    let disposed = false;
    api
      .listApplicationsWithSource()
      .then((inv) => {
        if (disposed) return;
        setApplications(inv.applications);
        setSource(inv.source);
        setEndpoint(inv.endpoint);
      })
      .catch((err) => {
        if (!disposed) setError(errorMessage(err));
      });
    return () => {
      disposed = true;
    };
  }, [api]);

  const reload = useCallback(async () => {
    setReloading(true);
    setError(null);
    try {
      const inv = await api.listApplicationsWithSource();
      setApplications(inv.applications);
      setSource(inv.source);
      setEndpoint(inv.endpoint);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReloading(false);
    }
  }, [api]);

  return { applications, error, source, endpoint, reloading, reload };
}

/** The "N applications from Konveyor Hub · <endpoint> · Refresh" line. */
export function InventorySourceLine({ inventory }: { inventory: ApplicationInventory }) {
  const { source, endpoint, applications, reloading, reload } = inventory;
  if (!source) return null;
  return (
    <div className={`inventory-source inventory-source-${source}`}>
      <span className="inventory-source-label">
        {source === "hub"
          ? `${applications.length} application${applications.length === 1 ? "" : "s"} from Konveyor Hub`
          : source === "stub"
            ? "Konveyor Hub unavailable — showing offline stub"
            : "Application inventory"}
      </span>
      <code className="inventory-source-endpoint">{endpoint}</code>
      <Button
        variant="link"
        isInline
        isLoading={reloading}
        isDisabled={reloading}
        onClick={() => void reload()}
      >
        Refresh
      </Button>
    </div>
  );
}

// --------------------------------------------- what the harness will pull

/**
 * Read-only preview of what the harness fetches from the Hub for the
 * selected application at pod start. These are NOT form inputs: the
 * platform injects only Hub coordinates + APP_ID + TARGET_BRANCH; the
 * harness resolves the rest in-pod and never hands the git credentials to
 * the agent.
 */
export function HarnessPullsPreview({ application }: { application: Application | undefined }) {
  if (!application) return null;
  return (
    <dl
      className="resolved-params"
      role="group"
      aria-label="What the harness pulls from the Hub for this application"
    >
      <div className="resolved-param">
        <dt>
          <code>repository</code>
        </dt>
        <dd className="resolved-param-source">
          <span aria-hidden="true">← </span>
          pulled from Hub
          {application.repository?.url ? (
            <span className="resolved-param-value">{truncate(application.repository.url, 60)}</span>
          ) : (
            <span className="resolved-param-value resolved-param-missing">
              no repository on this application
            </span>
          )}
        </dd>
      </div>
      <div className="resolved-param">
        <dt>
          <code>source branch</code>
        </dt>
        <dd className="resolved-param-source">
          <span aria-hidden="true">← </span>
          pulled from Hub
          <span className="resolved-param-value">
            {application.repository?.branch ?? "(repository default)"}
          </span>
        </dd>
      </div>
      <div className="resolved-param">
        <dt>
          <code>git credentials</code>
        </dt>
        <dd className="resolved-param-source">
          <span aria-hidden="true">← </span>
          {application.identity ? (
            <span className="resolved-param-value">
              Hub identity: {application.identity.name} — decrypted in-pod, never given to the
              agent
            </span>
          ) : (
            <span className="resolved-param-value">
              no app-specific identity — the harness falls back to the Hub's default source
              credential if one is configured, else clones anonymously
            </span>
          )}
        </dd>
      </div>
      <div className="resolved-param">
        <dt>
          <code>analysis</code>
        </dt>
        <dd className="resolved-param-source">
          <span aria-hidden="true">← </span>
          <span className="resolved-param-value">
            latest insights, written to .konveyor/analysis.json in the workspace
          </span>
        </dd>
      </div>
    </dl>
  );
}

// ----------------------------------------------------- shared status pieces

/** The Ready condition of any catalog CR (Agent, SkillCard, Playbook, …). */
export function readyCondition(res: {
  status?: { conditions?: Condition[] };
}): Condition | undefined {
  return res.status?.conditions?.find((c) => c.type === "Ready");
}

/**
 * Green/red/grey Ready badge. No condition yet — controller catching up or
 * not running — renders grey "Unknown", NOT red: absence of status is the
 * normal state right after a create.
 */
export function ReadyLabel({ resource }: { resource: { status?: { conditions?: Condition[] } } }) {
  const cond = readyCondition(resource);
  const color = cond?.status === "True" ? "green" : cond?.status === "False" ? "red" : "grey";
  const text = cond?.status === "True" ? "Ready" : cond?.status === "False" ? "Not ready" : "Unknown";
  return (
    <Label isCompact color={color} title={cond?.message ?? cond?.reason}>
      {text}
    </Label>
  );
}

// ------------------------------------------------------------ LLM providers

/**
 * All LLMProvider CRs (unfiltered — cluster-admin-owned). Non-blocking like
 * the application inventory: pickers degrade to the default policy on error.
 */
export function useProviders(api: ShimClient): {
  providers: LLMProvider[];
  error: string | null;
} {
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    api
      .listProviders()
      .then((list) => {
        if (!disposed) setProviders(list);
      })
      .catch((err) => {
        if (!disposed) setError(errorMessage(err));
      });
    return () => {
      disposed = true;
    };
  }, [api]);
  return { providers, error };
}

/**
 * The model the platform picks when the caller picks nothing — MUST mirror
 * the shim's resolveModels policy: the (stage-shared) first declared
 * provider, its primary-tier model, else its first model. Shown as the
 * "Default" option so the form previews exactly what omission means.
 */
export function defaultModelFor(
  providerRefs: string[],
  providers: LLMProvider[],
): { provider: string; model: string } | undefined {
  const ref = providerRefs[0];
  if (!ref) return undefined;
  const provider = providers.find((p) => p.metadata.name === ref);
  const model =
    (provider?.spec.models?.find((m) => m.tier === "primary") ?? provider?.spec.models?.[0])?.name;
  return model ? { provider: ref, model } : undefined;
}

/**
 * Model picker for the create modals: "" = the platform default (previewed),
 * or an explicit provider/model pair sent as the create input's `model`.
 * `allowedProviderRefs` is the agent's declared providers (single run) or
 * the INTERSECTION across stage agents (playbook — models apply to every
 * stage). Options index into a flat list; the value is that index, so
 * provider/model strings never need escaping.
 */
export function ModelPicker({
  id,
  allowedProviderRefs,
  providers,
  value,
  onChange,
}: {
  id: string;
  allowedProviderRefs: string[];
  providers: LLMProvider[];
  value: { provider: string; model: string } | null;
  onChange: (choice: { provider: string; model: string } | null) => void;
}) {
  const options: { provider: string; model: string; tier?: string }[] = [];
  for (const ref of allowedProviderRefs) {
    const provider = providers.find((p) => p.metadata.name === ref);
    for (const m of provider?.spec.models ?? []) {
      options.push({ provider: ref, model: m.name, tier: m.tier });
    }
  }
  const fallback = defaultModelFor(allowedProviderRefs, providers);
  const selectedIndex = value
    ? options.findIndex((o) => o.provider === value.provider && o.model === value.model)
    : -1;
  if (options.length === 0) return null;
  return (
    <FormSelect
      id={id}
      value={selectedIndex >= 0 ? String(selectedIndex) : ""}
      onChange={(_e, v) => {
        const opt = v === "" ? undefined : options[Number(v)];
        onChange(opt ? { provider: opt.provider, model: opt.model } : null);
      }}
      aria-label="Model"
    >
      <FormSelectOption
        value=""
        label={
          fallback
            ? `Default policy — ${fallback.provider} / ${fallback.model}`
            : "Default policy (harness decides)"
        }
      />
      {options.map((o, i) => (
        <FormSelectOption
          key={`${o.provider}/${o.model}`}
          value={String(i)}
          label={`${o.provider} / ${o.model}${o.tier ? `  ·  ${o.tier}` : ""}`}
        />
      ))}
    </FormSelect>
  );
}

// ------------------------------------------------------- typed param inputs

/** Why a param value cannot be submitted, or undefined when it can. */
export function paramValueInvalidReason(p: AgentParam, value: string): string | undefined {
  const v = value.trim();
  if (!v) return undefined; // emptiness is handled by the required check
  if (p.type === "number" && !Number.isFinite(Number(v))) return "must be a number";
  return undefined;
}

/**
 * The right widget for a declared AgentParam: boolean -> checkbox mapped to
 * "true"/"false" (unset stays "" and is omitted from the create), number ->
 * numeric input, string -> text input. Values stay strings throughout —
 * that's what AgentRun params are.
 */
export function ParamValueField({
  id,
  param,
  value,
  onChange,
  isDisabled,
}: {
  id: string;
  param: AgentParam;
  value: string;
  onChange: (value: string) => void;
  isDisabled?: boolean;
}) {
  if (param.type === "boolean") {
    return (
      <Checkbox
        id={id}
        label={
          value === "true"
            ? "true"
            : value === "false"
              ? "false"
              : "not set (agent default applies)"
        }
        isChecked={value === "true"}
        isDisabled={isDisabled}
        onChange={(_e, checked) => onChange(checked ? "true" : "false")}
      />
    );
  }
  const invalid = paramValueInvalidReason(param, value);
  return (
    <TextInput
      id={id}
      type={param.type === "number" ? "number" : "text"}
      isRequired={param.required}
      value={value}
      isDisabled={isDisabled}
      validated={invalid ? "error" : "default"}
      onChange={(_e, v) => onChange(v)}
    />
  );
}

// ------------------------------------------------- run-spec env extraction

/** Value of one injected RUN_ENV var on a run spec (TARGET_BRANCH, APP_ID…). */
export function runEnvValue(env: EnvVar[] | undefined, name: string): string | undefined {
  return env?.find((e) => e.name === name)?.value;
}

/** The Hub coordinates + branch a run was created with, from its spec.env. */
export function runHubCoordinates(env: EnvVar[] | undefined): {
  appId?: string;
  targetBranch?: string;
  hubBaseUrl?: string;
  hasToken: boolean;
} {
  return {
    appId: runEnvValue(env, RUN_ENV.APP_ID),
    targetBranch: runEnvValue(env, RUN_ENV.TARGET_BRANCH),
    hubBaseUrl: runEnvValue(env, RUN_ENV.HUB_BASE_URL),
    // The shim injects HUB_TOKEN via valueFrom.secretKeyRef (no plain value),
    // so presence of the env entry — not a .value — is what counts.
    hasToken: env?.some((e) => e.name === RUN_ENV.HUB_TOKEN) ?? false,
  };
}
