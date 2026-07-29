import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  Spinner,
  TextInput,
} from "@patternfly/react-core";
import { defaultTargetBranch, invalidTargetBranchReason } from "@konveyor/agentic-client/contract";
import type {
  AgentParam,
  AgentPlaybook,
  AgentResource,
  Condition,
} from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, truncate } from "../format";
import {
  HarnessPullsPreview,
  InventorySourceLine,
  ModelPicker,
  ParamValueField,
  paramHelperText,
  paramValueInvalidReason,
  skillCount,
  useApplicationInventory,
  useProviders,
} from "./sources";

interface CreatePlaybookRunModalProps {
  api: ShimClient;
  onClose: () => void;
  onCreated: (runName: string) => void;
}

function readyCondition(pb: AgentPlaybook): Condition | undefined {
  return pb.status?.conditions?.find((c) => c.type === "Ready");
}

/**
 * Selectable unless the controller has EXPLICITLY marked the playbook not
 * ready (AgentsNotReady etc.). No status yet — controller catching up or
 * not running — fails open: the shim re-validates on create anyway.
 */
function isSelectable(pb: AgentPlaybook): boolean {
  return readyCondition(pb)?.status !== "False";
}

/**
 * UNION of the stage Agents' declared params, in stage order. First
 * declaration wins the description/type/default (later defaults fill a
 * hole); required anywhere means required. Params forward wholesale to
 * every stage's AgentRun, so only params declared by EVERY stage agent
 * (see stagesMissingParam) are settable — the rest render disabled and
 * are never submitted (the shim rejects them with a 400 anyway).
 */
function mergeParams(agents: AgentResource[]): AgentParam[] {
  const merged = new Map<string, AgentParam>();
  for (const agent of agents) {
    for (const p of agent.spec.params ?? []) {
      const prev = merged.get(p.name);
      if (!prev) {
        merged.set(p.name, { ...p });
        continue;
      }
      if (p.required) prev.required = true;
      if (prev.default === undefined && p.default !== undefined) prev.default = p.default;
      if (!prev.description && p.description) prev.description = p.description;
    }
  }
  return [...merged.values()];
}

/** Names of the stage agents that do NOT declare the given param. */
function stagesMissingParam(agents: AgentResource[], name: string): string[] {
  return agents
    .filter((a) => !(a.spec.params ?? []).some((q) => q.name === name))
    .map((a) => a.metadata.name ?? "(unnamed)");
}

function defaultsFor(params: AgentParam[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const p of params) {
    values[p.name] = p.default ?? "";
  }
  return values;
}

export function CreatePlaybookRunModal({ api, onClose, onCreated }: CreatePlaybookRunModalProps) {
  const [playbooks, setPlaybooks] = useState<AgentPlaybook[] | null>(null);
  const [playbooksError, setPlaybooksError] = useState<string | null>(null);
  const [playbookName, setPlaybookName] = useState("");
  // The selected playbook's stage Agents, fetched by name (get-by-name is
  // unfiltered, so stage agents without the managed label still resolve).
  const [stageAgents, setStageAgents] = useState<AgentResource[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const inventory = useApplicationInventory(api);
  const { applications, error: applicationsError } = inventory;
  const { providers, error: providersError } = useProviders(api);
  const [model, setModel] = useState<{ provider: string; model: string } | null>(null);
  const [applicationId, setApplicationId] = useState("");
  const [targetBranch, setTargetBranch] = useState(() => defaultTargetBranch());
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    api
      .listPlaybooks()
      .then((list) => {
        if (disposed) return;
        setPlaybooks(list);
        const first = list.find(isSelectable) ?? (list.length > 0 ? list[0] : undefined);
        if (first?.metadata.name) setPlaybookName(first.metadata.name);
      })
      .catch((err) => {
        if (!disposed) setPlaybooksError(errorMessage(err));
      });
    return () => {
      disposed = true;
    };
  }, [api]);

  const selected = playbooks?.find((pb) => pb.metadata.name === playbookName);

  // Fetch the selected playbook's stage Agents — their declared params (as
  // a union) are the run's form. Params reset to the union's defaults.
  useEffect(() => {
    if (!selected) return;
    let disposed = false;
    setStageAgents(null);
    setAgentsError(null);
    const refs = [...new Set(selected.spec.stages.map((s) => s.agentRef))];
    Promise.all(refs.map((ref) => api.getAgent(ref)))
      .then((list) => {
        if (disposed) return;
        setStageAgents(list);
        setParamValues(defaultsFor(mergeParams(list)));
      })
      .catch((err) => {
        if (!disposed) setAgentsError(errorMessage(err));
      });
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selected is derived from these
  }, [api, playbookName, playbooks]);

  const selectedReady = selected ? isSelectable(selected) : false;
  const notReady = selected && !selectedReady ? readyCondition(selected) : undefined;

  const mergedParams = mergeParams(stageAgents ?? []);
  // Only params declared by EVERY stage agent can be sent (params forward
  // wholesale to each stage); the rest render disabled below.
  const universalParams = mergedParams.filter(
    (p) => stagesMissingParam(stageAgents ?? [], p.name).length === 0,
  );
  // The shim refuses application-scoped creates when the inventory is the
  // offline stub — stub applications have no Hub behind them to pull from.
  const stubInventory = inventory.source === "stub";
  const application = applications.find((a) => a.id === applicationId);
  // A stage agent with zero skills dooms its stage under the migration
  // harness (fatal at startup) — surface it before Create, not after.
  const skilllessAgents = application
    ? (stageAgents ?? []).filter((a) => skillCount(a) === 0)
    : [];
  const skilledNoApp =
    !application && (stageAgents ?? []).some((a) => skillCount(a) > 0);
  const repoMissing = !!application && !application.repository?.url;
  // The picker offers only providers EVERY stage agent declares (one model
  // selection forwards to every stage), in the first stage agent's
  // declaration order — mirroring the default policy's ordering.
  const allowedProviderRefs =
    stageAgents === null
      ? []
      : [...new Set((stageAgents[0]?.spec.providers ?? []).map((p) => p.ref))].filter((ref) =>
          stageAgents.every((a) => (a.spec.providers ?? []).some((q) => q.ref === ref)),
        );
  // spec.models applies to every stage with no per-stage overrides. The shim
  // resolves the default from the INTERSECTION of the stage agents' full
  // provider lists and accepts any explicit model whose provider every stage
  // agent declares — so only an EMPTY intersection blocks create (when at
  // least one stage agent declares providers at all).
  const providersDisagree =
    stageAgents !== null &&
    stageAgents.some((a) => (a.spec.providers ?? []).length > 0) &&
    allowedProviderRefs.length === 0;

  const missingRequired = universalParams.filter(
    (p) => p.required && !(paramValues[p.name] ?? "").trim(),
  );
  const paramsInvalid = universalParams.some(
    (p) => paramValueInvalidReason(p, paramValues[p.name] ?? "") !== undefined,
  );
  // Mirror the shim's validation: with an application, the shared target
  // branch must be a valid git refname and differ from the source branch.
  const branchInvalid =
    !!application &&
    (invalidTargetBranchReason(targetBranch) !== undefined ||
      (application.repository?.branch !== undefined &&
        targetBranch.trim() === application.repository.branch));
  const canCreate =
    !!selected &&
    selectedReady &&
    stageAgents !== null &&
    missingRequired.length === 0 &&
    !paramsInvalid &&
    !branchInvalid &&
    !repoMissing &&
    !providersDisagree &&
    !submitting;

  const submit = async () => {
    if (!selected || !canCreate) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Send only universal params (the shim 400s params not declared by
      // every stage agent). Omit a value only when it is empty, or when it
      // equals the merged default AND every stage agent's declaration
      // carries that same default — a value that some stage would default
      // differently must be sent even if it matches the merged default.
      const params: Record<string, string> = {};
      for (const p of universalParams) {
        const v = (paramValues[p.name] ?? "").trim();
        if (!v) continue;
        const uniformDefault =
          p.default !== undefined &&
          (stageAgents ?? []).every((a) =>
            (a.spec.params ?? []).some((q) => q.name === p.name && q.default === p.default),
          );
        if (uniformDefault && v === (p.default ?? "").trim()) continue;
        params[p.name] = v;
      }
      const created = await api.createPlaybookRun({
        playbookRef: selected.metadata.name ?? playbookName,
        params: Object.keys(params).length > 0 ? params : undefined,
        applicationRef: application?.id,
        targetBranch: application ? targetBranch.trim() : undefined,
        model: model ?? undefined,
      });
      const name = created.metadata.name;
      if (!name) throw new Error("shim returned a created playbook run without metadata.name");
      onCreated(name);
    } catch (err) {
      setSubmitError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <Modal
      variant={ModalVariant.medium}
      isOpen
      onClose={() => {
        if (!submitting) onClose();
      }}
      aria-labelledby="create-playbook-run-title"
    >
      <ModalHeader
        title="Create playbook run"
        labelId="create-playbook-run-title"
        description="Creates an AgentPlaybookRun; the controller executes each stage as its own AgentRun, in order, on a shared target branch."
      />
      <ModalBody>
        {playbooksError && (
          <Alert variant="danger" isInline title="Failed to load playbooks" style={{ marginBottom: "1rem" }}>
            {playbooksError}
          </Alert>
        )}
        {submitError && (
          <Alert variant="danger" isInline title="Create failed" style={{ marginBottom: "1rem" }}>
            {submitError}
          </Alert>
        )}
        {playbooks === null && !playbooksError ? (
          <Spinner aria-label="Loading playbooks" />
        ) : playbooks !== null && playbooks.length === 0 ? (
          <Alert variant="warning" isInline title="No AgentPlaybook resources found">
            The cluster has no AgentPlaybook CRs in the shim's namespace, so there is nothing to
            run.
          </Alert>
        ) : (
          <Form
            id="create-playbook-run-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <FormGroup label="Playbook" isRequired fieldId="create-playbook">
              <FormSelect
                id="create-playbook"
                value={playbookName}
                onChange={(_e, v) => {
                  setPlaybookName(v);
                  setModel(null);
                }}
              >
                {(playbooks ?? []).map((pb) => (
                  <FormSelectOption
                    key={pb.metadata.name}
                    value={pb.metadata.name}
                    label={
                      (pb.metadata.name ?? "(unnamed)") +
                      (isSelectable(pb) ? "" : " (not ready)")
                    }
                    isDisabled={!isSelectable(pb)}
                  />
                ))}
              </FormSelect>
              {selected && selected.spec.stages.length > 0 && (
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>
                      {selected.spec.stages.length} stage
                      {selected.spec.stages.length === 1 ? "" : "s"}:{" "}
                      {selected.spec.stages.map((s) => s.name).join(" → ")}
                    </HelperTextItem>
                    {selected.spec.guide && (
                      <HelperTextItem>{truncate(selected.spec.guide, 160)}</HelperTextItem>
                    )}
                  </HelperText>
                </FormHelperText>
              )}
            </FormGroup>

            {notReady && (
              <Alert variant="warning" isInline title="Playbook is not ready">
                {notReady.reason ?? "NotReady"}
                {notReady.message ? ` — ${notReady.message}` : ""}
              </Alert>
            )}

            {agentsError && (
              <Alert variant="danger" isInline title="Failed to load the playbook's stage agents">
                {agentsError} — the run form is built from the stage Agents' declared params, so a
                run cannot be created until they load.
              </Alert>
            )}
            {selected && stageAgents === null && !agentsError && (
              <Spinner size="md" aria-label="Loading stage agents" />
            )}

            {applicationsError && (
              <Alert variant="warning" isInline title="Failed to load applications">
                {applicationsError} — playbook runs that work on a Hub application cannot be
                created until the inventory loads.
              </Alert>
            )}

            <InventorySourceLine inventory={inventory} />

            <FormGroup label="Application" fieldId="create-pb-application">
              <FormSelect
                id="create-pb-application"
                value={applicationId}
                onChange={(_e, v) => setApplicationId(v)}
              >
                <FormSelectOption value="" label="None — run without an application" />
                {applications.map((a) => (
                  <FormSelectOption
                    key={a.id}
                    value={a.id}
                    label={`${a.name}  ·  Hub #${a.id}`}
                    isDisabled={stubInventory}
                  />
                ))}
              </FormSelect>
              <FormHelperText>
                <HelperText>
                  {stubInventory && (
                    <HelperTextItem variant="warning">
                      Stub applications cannot back a run — the sandbox needs a reachable Hub.
                      Only "None" is usable until the Hub connects.
                    </HelperTextItem>
                  )}
                  <HelperTextItem>
                    Every stage's harness pulls this application's repository, credentials, and
                    analysis from the Hub. Migration playbooks fail without one.
                  </HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>

            {skilllessAgents.length > 0 && (
              <Alert variant="warning" isInline title="Stage agents without skills">
                {skilllessAgents.map((a) => a.metadata.name).join(", ")} declare no
                skillCards/skillCollections — the migration harness fails fatally with zero
                skills, so those stages are doomed.
              </Alert>
            )}

            {skilledNoApp && (
              <Alert variant="warning" isInline title="No application selected">
                This playbook's stage agents mount skills, so they run the migration harness —
                which fails at startup without the Hub coordinates and target branch an
                application provides. Select an application unless every stage is a fixture.
              </Alert>
            )}

            {repoMissing && (
              <Alert variant="danger" isInline title="Application has no repository">
                {application?.name} has no repository URL in the Hub — the harness clones from
                the Hub record, so these stages cannot start. Set the application's source
                repository first.
              </Alert>
            )}

            {providersDisagree && (
              <Alert variant="danger" isInline title="Stage agents share no LLM provider">
                The stage agents' declared provider lists have no ref in common — a playbook
                run's model applies to every stage with no per-stage overrides, so neither a
                default nor an explicit selection can apply to every stage.
              </Alert>
            )}

            {application && (
              <FormGroup label="Target branch" isRequired fieldId="create-pb-target-branch">
                <TextInput
                  id="create-pb-target-branch"
                  isRequired
                  value={targetBranch}
                  onChange={(_e, v) => setTargetBranch(v)}
                  validated={branchInvalid ? "error" : "default"}
                />
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem variant={branchInvalid ? "error" : "default"}>
                      {branchInvalid
                        ? "Must be a valid git branch name and differ from the application's source branch."
                        : "One branch, all stages: each stage continues the previous stage's work on it (plan commits PLAN.md, execute reads it)."}
                    </HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
            )}

            {application && <HarnessPullsPreview application={application} />}

            {mergedParams.map((p) => {
              const missingStages = stagesMissingParam(stageAgents ?? [], p.name);
              const partial = missingStages.length > 0;
              const helper = paramHelperText(p);
              const invalidReason = partial
                ? undefined
                : paramValueInvalidReason(p, paramValues[p.name] ?? "");
              return (
                <FormGroup
                  key={p.name}
                  label={p.name}
                  isRequired={!partial && p.required}
                  fieldId={`pb-param-${p.name}`}
                >
                  <ParamValueField
                    id={`pb-param-${p.name}`}
                    param={p}
                    value={paramValues[p.name] ?? ""}
                    isDisabled={partial}
                    onChange={(v) => setParamValues((prev) => ({ ...prev, [p.name]: v }))}
                  />
                  {(partial || helper || invalidReason) && (
                    <FormHelperText>
                      <HelperText>
                        {partial && (
                          <HelperTextItem variant="warning">
                            not declared by stage{missingStages.length === 1 ? "" : "s"}{" "}
                            {missingStages.join(", ")} — cannot be set on a playbook run (params
                            forward to every stage)
                          </HelperTextItem>
                        )}
                        {invalidReason && (
                          <HelperTextItem variant="error">{invalidReason}</HelperTextItem>
                        )}
                        {helper && <HelperTextItem>{helper}</HelperTextItem>}
                      </HelperText>
                    </FormHelperText>
                  )}
                </FormGroup>
              );
            })}

            <FormGroup label="Model" fieldId="create-pb-model">
              <ModelPicker
                id="create-pb-model"
                allowedProviderRefs={allowedProviderRefs}
                providers={providers}
                value={model}
                onChange={setModel}
              />
              <FormHelperText>
                <HelperText>
                  {providersError && (
                    <HelperTextItem>
                      Model picker unavailable ({providersError}) — the default policy applies.
                    </HelperTextItem>
                  )}
                  <HelperTextItem>
                    Default: the platform picks the first declared provider's primary-tier model.
                    Provider CR names map verbatim to goose provider ids.
                  </HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>
          </Form>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" isDisabled={!canCreate} isLoading={submitting} onClick={() => void submit()}>
          Create
        </Button>
        <Button variant="link" isDisabled={submitting} onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
}
