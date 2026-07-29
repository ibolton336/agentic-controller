import { useEffect, useMemo, useRef, useState } from "react";
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
  TextArea,
  TextInput,
} from "@patternfly/react-core";
import type {
  AgentPlaybook,
  AgentPlaybookSpec,
  AgentResource,
} from "@konveyor/agentic-client/contract";
import {
  RESOURCE_NAME_MAX,
  RESOURCE_NAME_PATTERN,
  STAGE_NAME_PATTERN,
} from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage } from "../format";
import { skillCount } from "./sources";

interface StageDraft {
  /** Client-side row identity — survives reorders. */
  key: number;
  name: string;
  agentRef: string;
  instructions: string;
}

interface PlaybookComposerModalProps {
  api: ShimClient;
  /** When set, edit this playbook (name locked); otherwise create. */
  playbook?: AgentPlaybook;
  onClose: () => void;
  onSaved: (name: string) => void;
}

function invalidNameReason(name: string): string | undefined {
  const n = name.trim();
  if (!n) return "a name is required";
  if (n.length > RESOURCE_NAME_MAX) return `at most ${RESOURCE_NAME_MAX} characters`;
  if (!RESOURCE_NAME_PATTERN.test(n)) {
    return "lowercase alphanumerics, '-' and '.', starting and ending alphanumeric";
  }
  return undefined;
}

function invalidStageNameReason(name: string, duplicate: boolean): string | undefined {
  if (!name.trim()) return "a stage name is required";
  if (name.length > 63) return "at most 63 characters";
  if (!STAGE_NAME_PATTERN.test(name)) {
    return "label-safe: lowercase alphanumerics, '-', '.', starting and ending alphanumeric";
  }
  if (duplicate) return "stage names must be unique within the playbook";
  return undefined;
}

export function PlaybookComposerModal({
  api,
  playbook,
  onClose,
  onSaved,
}: PlaybookComposerModalProps) {
  const isEdit = playbook !== undefined;
  const nextKey = useRef(0);
  const [name, setName] = useState(playbook?.metadata.name ?? "");
  const [guide, setGuide] = useState(playbook?.spec.guide ?? "");
  const [stages, setStages] = useState<StageDraft[]>(() =>
    playbook
      ? playbook.spec.stages.map((s) => ({
          key: nextKey.current++,
          name: s.name,
          agentRef: s.agentRef,
          instructions: s.instructions ?? "",
        }))
      : [{ key: nextKey.current++, name: "", agentRef: "", instructions: "" }],
  );
  const [agents, setAgents] = useState<AgentResource[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  // Per-agentRef fetch results for the advisories; null = fetch failed.
  const [fetchedAgents, setFetchedAgents] = useState<Record<string, AgentResource | null>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    api
      .listAgents()
      .then((list) => {
        if (!disposed) setAgents(list);
      })
      .catch((err) => {
        if (!disposed) setAgentsError(errorMessage(err));
      });
    return () => {
      disposed = true;
    };
  }, [api]);

  // Fetch each unique referenced agent whenever the set of agentRefs changes
  // (tolerating individual failures) to power the provider-overlap and
  // zero-skills advisories.
  const agentRefsKey = useMemo(() => {
    const unique = new Set(stages.map((s) => s.agentRef).filter((r) => r !== ""));
    return [...unique].sort().join(",");
  }, [stages]);

  useEffect(() => {
    const refs = agentRefsKey === "" ? [] : agentRefsKey.split(",");
    if (refs.length === 0) {
      setFetchedAgents({});
      return;
    }
    let disposed = false;
    void Promise.all(
      refs.map(async (ref) => [ref, await api.getAgent(ref).catch(() => null)] as const),
    ).then((entries) => {
      if (!disposed) setFetchedAgents(Object.fromEntries(entries));
    });
    return () => {
      disposed = true;
    };
  }, [api, agentRefsKey]);

  // Provider-overlap advisory: one shared model selection is forwarded to
  // every stage, so the run 400s when stage agents' first providers disagree.
  const stageFirstProviders = stages
    .filter((s) => s.agentRef !== "")
    .map((s) => ({
      stage: s.name.trim() || "(unnamed stage)",
      provider: fetchedAgents[s.agentRef]?.spec.providers?.[0]?.ref,
    }))
    .filter((e): e is { stage: string; provider: string } => e.provider !== undefined);
  const distinctProviders = new Set(stageFirstProviders.map((e) => e.provider));
  const providersDisagree = distinctProviders.size > 1;

  const managedAgentNames = (agents ?? [])
    .map((a) => a.metadata.name)
    .filter((n): n is string => n !== undefined);

  const stageNameCounts = new Map<string, number>();
  for (const s of stages) {
    const n = s.name.trim();
    if (n) stageNameCounts.set(n, (stageNameCounts.get(n) ?? 0) + 1);
  }

  const nameReason = isEdit ? undefined : invalidNameReason(name);
  const stageProblems = stages.map((s) => ({
    nameReason: invalidStageNameReason(s.name, (stageNameCounts.get(s.name.trim()) ?? 0) > 1),
    agentReason: s.agentRef === "" ? "select an agent for this stage" : undefined,
  }));
  const stagesValid =
    stages.length >= 1 && stageProblems.every((p) => !p.nameReason && !p.agentReason);
  const canSave = !submitting && nameReason === undefined && stagesValid;

  const updateStage = (key: number, patch: Partial<StageDraft>) => {
    setStages((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  };

  const moveStage = (index: number, delta: -1 | 1) => {
    setStages((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [row] = next.splice(index, 1);
      next.splice(to, 0, row);
      return next;
    });
  };

  const removeStage = (key: number) => {
    setStages((prev) => prev.filter((s) => s.key !== key));
  };

  const addStage = () => {
    setStages((prev) => [
      ...prev,
      {
        key: nextKey.current++,
        name: "",
        agentRef: managedAgentNames[0] ?? "",
        instructions: "",
      },
    ]);
  };

  const submit = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setSubmitError(null);
    const finalName = (isEdit ? (playbook?.metadata.name ?? "") : name).trim();
    const spec: AgentPlaybookSpec = {
      guide: guide.trim() || undefined,
      stages: stages.map((s) => ({
        name: s.name.trim(),
        agentRef: s.agentRef,
        instructions: s.instructions.trim() || undefined,
      })),
    };
    try {
      if (isEdit) {
        await api.updatePlaybook(finalName, spec);
      } else {
        await api.createPlaybook(finalName, spec);
      }
      onSaved(finalName);
    } catch (err) {
      setSubmitError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <Modal
      variant={ModalVariant.large}
      isOpen
      onClose={() => {
        if (!submitting) onClose();
      }}
      aria-labelledby="playbook-composer-title"
    >
      <ModalHeader
        title={isEdit ? "Edit playbook" : "Create playbook"}
        labelId="playbook-composer-title"
        description="An AgentPlaybook is a reusable multi-stage template; saving it executes nothing until a playbook run references it."
      />
      <ModalBody>
        {agentsError && (
          <Alert
            variant="danger"
            isInline
            title="Failed to load agents"
            style={{ marginBottom: "1rem" }}
          >
            {agentsError}
          </Alert>
        )}
        {submitError && (
          <Alert
            variant="danger"
            isInline
            title={isEdit ? "Update failed" : "Create failed"}
            style={{ marginBottom: "1rem" }}
          >
            {submitError}
          </Alert>
        )}
        <Alert
          variant="info"
          isInline
          title="How stages chain"
          style={{ marginBottom: "1rem" }}
        >
          Stages chain via committed artifacts on the one shared target branch — e.g. a plan
          stage commits PLAN.md and the execute stage reads it from the branch. A stage's chat
          output is never fed into the next stage's prompt: literal prompt-chaining (handoff.md,
          ADR 0006) is not implemented upstream.
        </Alert>
        {providersDisagree && (
          <Alert
            variant="warning"
            isInline
            title="Stage agents' first providers disagree"
            style={{ marginBottom: "1rem" }}
          >
            Running this playbook will fail (400): one shared model selection is forwarded to
            every stage, and the stage agents' first declared providers disagree —{" "}
            {stageFirstProviders.map((e) => `${e.stage}: ${e.provider}`).join(", ")}.
          </Alert>
        )}
        <Form
          id="playbook-composer-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FormGroup label="Name" isRequired fieldId="playbook-name">
            <TextInput
              id="playbook-name"
              isRequired
              isDisabled={isEdit}
              value={name}
              validated={!isEdit && name !== "" && nameReason ? "error" : "default"}
              onChange={(_e, v) => setName(v)}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem
                  variant={!isEdit && name !== "" && nameReason ? "error" : "default"}
                >
                  {isEdit
                    ? "Names are immutable — edits replace the spec of this playbook."
                    : (nameReason ??
                      "Kubernetes object name: lowercase alphanumerics, '-' and '.'")}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label="Guide" fieldId="playbook-guide">
            <TextArea
              id="playbook-guide"
              value={guide}
              onChange={(_e, v) => setGuide(v)}
              rows={4}
              resizeOrientation="vertical"
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  Injected into every stage as KONVEYOR_PLAYBOOK_INSTRUCTIONS, between the
                  agent's standing prompt and its mounted skills.
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label="Stages" isRequired fieldId="playbook-stages">
            {stages.length === 0 && (
              <FormHelperText>
                <HelperText>
                  <HelperTextItem variant="error">
                    At least one stage is required.
                  </HelperTextItem>
                </HelperText>
              </FormHelperText>
            )}
            {stages.map((stage, index) => {
              const problems = stageProblems[index];
              const fetched =
                stage.agentRef !== "" ? fetchedAgents[stage.agentRef] : undefined;
              const zeroSkills = !!fetched && skillCount(fetched) === 0;
              const unlabeled =
                stage.agentRef !== "" && !managedAgentNames.includes(stage.agentRef);
              return (
                <div
                  key={stage.key}
                  style={{
                    border: "1px solid var(--pf-t--global--border--color--default)",
                    borderRadius: "4px",
                    padding: "1rem",
                    marginBottom: "1rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <strong>Stage {index + 1}</strong>
                    <span style={{ display: "flex", gap: "0.75rem" }}>
                      <Button
                        variant="link"
                        isInline
                        isDisabled={index === 0}
                        onClick={() => moveStage(index, -1)}
                      >
                        Move up
                      </Button>
                      <Button
                        variant="link"
                        isInline
                        isDisabled={index === stages.length - 1}
                        onClick={() => moveStage(index, 1)}
                      >
                        Move down
                      </Button>
                      <Button
                        variant="link"
                        isInline
                        isDanger
                        onClick={() => removeStage(stage.key)}
                      >
                        Remove
                      </Button>
                    </span>
                  </div>
                  <FormGroup
                    label="Stage name"
                    isRequired
                    fieldId={`stage-name-${stage.key}`}
                  >
                    <TextInput
                      id={`stage-name-${stage.key}`}
                      isRequired
                      value={stage.name}
                      validated={
                        stage.name !== "" && problems.nameReason ? "error" : "default"
                      }
                      onChange={(_e, v) => updateStage(stage.key, { name: v })}
                    />
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem
                          variant={
                            stage.name !== "" && problems.nameReason ? "error" : "default"
                          }
                        >
                          {stage.name !== "" && problems.nameReason
                            ? problems.nameReason
                            : "label-safe: lowercase alphanumerics, '-', '.', used in labels on the stage's AgentRun"}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                  <FormGroup label="Agent" isRequired fieldId={`stage-agent-${stage.key}`}>
                    <FormSelect
                      id={`stage-agent-${stage.key}`}
                      value={stage.agentRef}
                      onChange={(_e, v) => updateStage(stage.key, { agentRef: v })}
                      aria-label="Stage agent"
                    >
                      <FormSelectOption value="" label="Select an agent" isDisabled />
                      {unlabeled && (
                        <FormSelectOption
                          value={stage.agentRef}
                          label={`${stage.agentRef} (unlabeled)`}
                        />
                      )}
                      {managedAgentNames.map((n) => (
                        <FormSelectOption key={n} value={n} label={n} />
                      ))}
                    </FormSelect>
                    {(problems.agentReason || zeroSkills) && (
                      <FormHelperText>
                        <HelperText>
                          {problems.agentReason && (
                            <HelperTextItem variant="error">
                              {problems.agentReason}
                            </HelperTextItem>
                          )}
                          {zeroSkills && (
                            <HelperTextItem>
                              {stage.agentRef} mounts zero skills — stage doomed under the
                              migration harness (it fails fatally with no skills mounted).
                            </HelperTextItem>
                          )}
                        </HelperText>
                      </FormHelperText>
                    )}
                  </FormGroup>
                  <FormGroup
                    label="Instructions"
                    fieldId={`stage-instructions-${stage.key}`}
                  >
                    <TextArea
                      id={`stage-instructions-${stage.key}`}
                      value={stage.instructions}
                      onChange={(_e, v) => updateStage(stage.key, { instructions: v })}
                      rows={2}
                      resizeOrientation="vertical"
                    />
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          Optional — composed with the agent's standing prompt for this stage.
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                </div>
              );
            })}
            <Button variant="secondary" onClick={addStage}>
              Add stage
            </Button>
          </FormGroup>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="primary"
          isDisabled={!canSave}
          isLoading={submitting}
          onClick={() => void submit()}
        >
          {isEdit ? "Save" : "Create"}
        </Button>
        <Button variant="link" isDisabled={submitting} onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
}
