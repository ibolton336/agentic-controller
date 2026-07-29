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
  TextArea,
  TextInput,
} from "@patternfly/react-core";
import { defaultTargetBranch, invalidTargetBranchReason } from "@konveyor/agentic-client/contract";
import type { AgentResource } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, truncate } from "../format";
import {
  AgentImageLine,
  HarnessPullsPreview,
  InventorySourceLine,
  ModelPicker,
  ParamValueField,
  paramHelperText,
  paramValueInvalidReason,
  skillCount,
  useApplicationInventory,
  useImageCatalog,
  useProviders,
} from "./sources";

interface CreateRunModalProps {
  api: ShimClient;
  onClose: () => void;
  onCreated: (runName: string) => void;
}

function defaultsFor(agent: AgentResource | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const p of agent?.spec.params ?? []) {
    values[p.name] = p.default ?? "";
  }
  return values;
}

export function CreateRunModal({ api, onClose, onCreated }: CreateRunModalProps) {
  const [agents, setAgents] = useState<AgentResource[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  // Application selection is optional: agents that work on a Hub application
  // need one (the harness pulls repo/creds/analysis from the Hub), fixtures
  // like the mock harness run without. An inventory failure therefore warns
  // but never blocks the form.
  const inventory = useApplicationInventory(api);
  const { applications, error: applicationsError } = inventory;
  const imageCatalog = useImageCatalog(api);
  const { providers, error: providersError } = useProviders(api);
  const [model, setModel] = useState<{ provider: string; model: string } | null>(null);
  const [applicationId, setApplicationId] = useState("");
  const [targetBranch, setTargetBranch] = useState(() => defaultTargetBranch());
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [instructions, setInstructions] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    api
      .listAgents()
      .then((list) => {
        if (disposed) return;
        setAgents(list);
        const first = list.length > 0 ? list[0] : undefined;
        if (first?.metadata.name) {
          setAgentName(first.metadata.name);
          setParamValues(defaultsFor(first));
        }
      })
      .catch((err) => {
        if (!disposed) setAgentsError(errorMessage(err));
      });
    return () => {
      disposed = true;
    };
  }, [api]);

  const selected = agents?.find((a) => a.metadata.name === agentName);

  const selectAgent = (name: string) => {
    setAgentName(name);
    setParamValues(defaultsFor(agents?.find((a) => a.metadata.name === name)));
    setModel(null);
  };

  const userParams = selected?.spec.params ?? [];
  // The shim refuses application-scoped creates when the inventory is the
  // offline stub — stub applications have no Hub behind them to pull from.
  const stubInventory = inventory.source === "stub";
  const application = applications.find((a) => a.id === applicationId);
  const skillless = !!application && skillCount(selected) === 0;
  // The inverse mismatch: an agent that mounts skills runs the migration
  // harness, which hard-requires the Hub coordinates an application brings.
  const skilledNoApp = !application && skillCount(selected) > 0;
  const repoMissing = !!application && !application.repository?.url;

  const allowedProviderRefs = (selected?.spec.providers ?? []).map((p) => p.ref);

  const missingRequired = userParams.filter((p) => p.required && !(paramValues[p.name] ?? "").trim());
  const paramsInvalid = userParams.some(
    (p) => paramValueInvalidReason(p, paramValues[p.name] ?? "") !== undefined,
  );
  // Mirror the shim's validation so Create is disabled with a reason instead
  // of failing on submit: with an application, the target branch must be a
  // valid git refname (shared rules) and differ from the source branch.
  const branchInvalid =
    !!application &&
    (invalidTargetBranchReason(targetBranch) !== undefined ||
      (application.repository?.branch !== undefined &&
        targetBranch.trim() === application.repository.branch));
  const canCreate =
    !!selected &&
    missingRequired.length === 0 &&
    !paramsInvalid &&
    !branchInvalid &&
    !repoMissing &&
    !submitting;

  const submit = async () => {
    if (!selected || !canCreate) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const params: Record<string, string> = {};
      for (const p of userParams) {
        const v = (paramValues[p.name] ?? "").trim();
        if (v) params[p.name] = v; // omit empty optional params
      }
      const created = await api.createRun({
        agentRef: selected.metadata.name ?? agentName,
        params: Object.keys(params).length > 0 ? params : undefined,
        instructions: instructions.trim() || undefined,
        applicationRef: application?.id,
        targetBranch: application ? targetBranch.trim() : undefined,
        model: model ?? undefined,
      });
      const name = created.metadata.name;
      if (!name) throw new Error("shim returned a created run without metadata.name");
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
      aria-labelledby="create-run-title"
    >
      <ModalHeader
        title="Create run"
        labelId="create-run-title"
        description="Creates an AgentRun; the controller provisions a sandbox pod running the agent's ACP server."
      />
      <ModalBody>
        {agentsError && (
          <Alert variant="danger" isInline title="Failed to load agents" style={{ marginBottom: "1rem" }}>
            {agentsError}
          </Alert>
        )}
        {submitError && (
          <Alert variant="danger" isInline title="Create failed" style={{ marginBottom: "1rem" }}>
            {submitError}
          </Alert>
        )}
        {agents === null && !agentsError ? (
          <Spinner aria-label="Loading agents" />
        ) : agents !== null && agents.length === 0 ? (
          <Alert variant="warning" isInline title="No Agent resources found">
            The cluster has no Agent CRs in the shim's namespace, so there is nothing to run.
          </Alert>
        ) : (
          <Form
            id="create-run-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <FormGroup label="Agent" isRequired fieldId="create-agent">
              <FormSelect
                id="create-agent"
                value={agentName}
                onChange={(_e, v) => selectAgent(v)}
              >
                {(agents ?? []).map((a) => (
                  <FormSelectOption
                    key={a.metadata.name}
                    value={a.metadata.name}
                    label={a.metadata.name ?? "(unnamed)"}
                  />
                ))}
              </FormSelect>
              {(selected?.spec.prompt || selected?.spec.image) && (
                <FormHelperText>
                  <HelperText>
                    {selected.spec.prompt && (
                      <HelperTextItem>{truncate(selected.spec.prompt, 160)}</HelperTextItem>
                    )}
                    {selected.spec.image && (
                      <HelperTextItem>
                        <AgentImageLine image={selected.spec.image} catalog={imageCatalog} />
                      </HelperTextItem>
                    )}
                  </HelperText>
                </FormHelperText>
              )}
            </FormGroup>

            {applicationsError && (
              <Alert variant="warning" isInline title="Failed to load applications">
                {applicationsError} — runs that work on a Hub application cannot be created until
                the inventory loads; agents without one are unaffected.
              </Alert>
            )}

            <InventorySourceLine inventory={inventory} />

            <FormGroup label="Application" fieldId="create-application">
              <FormSelect
                id="create-application"
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
                    The harness pulls this application's repository, credentials, and analysis
                    from the Hub at start. Migration agents fail without one; leave unset only
                    for fixtures like the mock harness.
                  </HelperTextItem>
                </HelperText>
              </FormHelperText>
            </FormGroup>

            {skillless && (
              <Alert variant="warning" isInline title="This agent declares no skills">
                {selected?.metadata.name} mounts no skillCards or skillCollections — the
                migration harness fails fatally with zero skills. Pick a different agent, or add
                skills to this one.
              </Alert>
            )}

            {skilledNoApp && (
              <Alert variant="warning" isInline title="No application selected">
                {selected?.metadata.name} mounts skills, so it runs the migration harness —
                which fails at startup without the Hub coordinates and target branch an
                application provides. Select an application unless this agent is a fixture.
              </Alert>
            )}

            {repoMissing && (
              <Alert variant="danger" isInline title="Application has no repository">
                {application?.name} has no repository URL in the Hub — the harness clones from
                the Hub record, so this run cannot start. Set the application's source
                repository first.
              </Alert>
            )}

            {application && (
              <FormGroup label="Target branch" isRequired fieldId="create-target-branch">
                <TextInput
                  id="create-target-branch"
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
                        : "The harness creates (or continues) this branch and pushes the migration work to it."}
                    </HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
            )}

            {application && <HarnessPullsPreview application={application} />}

            {userParams.map((p) => {
              const helper = paramHelperText(p);
              const invalidReason = paramValueInvalidReason(p, paramValues[p.name] ?? "");
              return (
                <FormGroup key={p.name} label={p.name} isRequired={p.required} fieldId={`param-${p.name}`}>
                  <ParamValueField
                    id={`param-${p.name}`}
                    param={p}
                    value={paramValues[p.name] ?? ""}
                    onChange={(v) => setParamValues((prev) => ({ ...prev, [p.name]: v }))}
                  />
                  {(helper || invalidReason) && (
                    <FormHelperText>
                      <HelperText>
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

            <FormGroup label="Model" fieldId="create-run-model">
              <ModelPicker
                id="create-run-model"
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

            <FormGroup label="Instructions" fieldId="create-instructions">
              <TextArea
                id="create-instructions"
                value={instructions}
                onChange={(_e, v) => setInstructions(v)}
                rows={4}
                resizeOrientation="vertical"
                placeholder="Task-specific instructions, composed with the agent's standing prompt"
              />
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
