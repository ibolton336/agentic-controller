import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Bullseye,
  Button,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Flex,
  FlexItem,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  PageSection,
  ProgressStep,
  ProgressStepper,
  Spinner,
  TextInput,
  Title,
} from "@patternfly/react-core";
import ArrowLeftIcon from "@patternfly/react-icons/dist/esm/icons/arrow-left-icon";
import type {
  AgentPlaybookRun,
  AgentPlaybookRunStage,
} from "@konveyor/agentic-client/contract";
import {
  defaultTargetBranch,
  invalidTargetBranchReason,
  isTerminalPhase,
} from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, formatAge } from "../format";
import { PhaseLabel } from "./PhaseLabel";
import { playbookDuration } from "./PlaybookRunsPage";
import { BranchPanel } from "./BranchPanel";
import { runHubCoordinates, useApplicationInventory } from "./sources";

const POLL_MS = 2_000;

/**
 * Map a stage phase to a ProgressStepper variant. Ready=False on the run
 * while a stage executes is the normal healthy state — only Failed is an
 * error here.
 */
function stepVariant(phase: AgentPlaybookRunStage["phase"]) {
  switch (phase) {
    case "Succeeded":
      return "success" as const;
    case "Failed":
      return "danger" as const;
    case "Running":
      return "info" as const;
    default:
      return "pending" as const;
  }
}

interface PlaybookRunDetailPageProps {
  api: ShimClient;
  name: string;
  onBack: () => void;
  /** Open a stage's AgentRun in the existing run detail page (ACP chat included). */
  onOpenRun: (runName: string) => void;
  /** Called after the playbook run is successfully deleted. */
  onDeleted: () => void;
  /** Navigate to the new playbook run a re-run created. */
  onRerun: (name: string) => void;
}

export function PlaybookRunDetailPage({
  api,
  name,
  onBack,
  onOpenRun,
  onDeleted,
  onRerun,
}: PlaybookRunDetailPageProps) {
  const [run, setRun] = useState<AgentPlaybookRun | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const inFlight = useRef(false);

  const [isDeleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [isRerunOpen, setRerunOpen] = useState(false);
  const [rerunBranch, setRerunBranch] = useState("");
  const [rerunSubmitting, setRerunSubmitting] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  // Inventory failures leave `application` undefined — BranchPanel copes.
  const inventory = useApplicationInventory(api);

  const refresh = useCallback(async () => {
    if (inFlight.current || gone) return;
    inFlight.current = true;
    try {
      setRun(await api.getPlaybookRun(name));
      setFetchError(null);
    } catch (err) {
      const msg = errorMessage(err);
      // Only a transport-level 404 means the run is gone for good; anything
      // else (transient 5xx, network hiccups, runs whose names contain
      // "404") surfaces as the danger alert while polling continues.
      if (/HTTP 404\b/.test(msg)) {
        setGone(true);
      }
      setFetchError(msg);
    } finally {
      inFlight.current = false;
    }
  }, [api, name, gone]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const stages = run?.status?.stages ?? [];
  const duration = run ? playbookDuration(run) : undefined;
  const coordinates = runHubCoordinates(run?.spec.env);
  const application = inventory.applications.find((a) => a.id === coordinates.appId);
  const params = run?.spec.params ?? [];
  const models = run?.spec.models ?? [];

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deletePlaybookRun(name);
      onDeleted();
    } catch (err) {
      setDeleteError(errorMessage(err));
      setDeleting(false);
    }
  };

  const openRerun = () => {
    setRerunError(null);
    setRerunBranch(coordinates.targetBranch ?? defaultTargetBranch());
    setRerunOpen(true);
  };

  // Mirror CreateRunModal's gating: with an application, the target branch
  // must be a valid git refname and differ from the application's source
  // branch — otherwise the shim rejects on submit.
  const rerunBranchReason = !coordinates.appId
    ? undefined
    : invalidTargetBranchReason(rerunBranch) ??
      (application?.repository?.branch !== undefined &&
      rerunBranch.trim() === application.repository.branch
        ? "must differ from the application's source branch"
        : undefined);
  const canRerun = run !== null && rerunBranchReason === undefined && !rerunSubmitting;

  const submitRerun = async () => {
    if (!run || !canRerun) return;
    setRerunSubmitting(true);
    setRerunError(null);
    try {
      const rerunParams = Object.fromEntries((run.spec.params ?? []).map((p) => [p.name, p.value]));
      const primary = run.spec.models?.find((m) => m.role === "primary");
      const created = await api.createPlaybookRun({
        playbookRef: run.spec.playbookRef,
        params: Object.keys(rerunParams).length > 0 ? rerunParams : undefined,
        applicationRef: coordinates.appId,
        targetBranch: coordinates.appId ? rerunBranch.trim() : undefined,
        model: primary ? { provider: primary.provider, model: primary.model } : undefined,
      });
      const newName = created.metadata.name;
      if (!newName) throw new Error("shim returned a created playbook run without metadata.name");
      onRerun(newName);
    } catch (err) {
      setRerunError(errorMessage(err));
      setRerunSubmitting(false);
    }
  };

  return (
    <PageSection>
      <Button variant="link" isInline icon={<ArrowLeftIcon />} onClick={onBack}>
        Back to playbook runs
      </Button>
      <Flex
        alignItems={{ default: "alignItemsCenter" }}
        spaceItems={{ default: "spaceItemsMd" }}
        style={{ margin: "0.5rem 0" }}
      >
        <FlexItem>
          <Title headingLevel="h2" size="xl">
            {name} <PhaseLabel phase={run?.status?.phase} />
          </Title>
        </FlexItem>
        <FlexItem align={{ default: "alignRight" }}>
          <Button variant="secondary" isDisabled={run === null} onClick={openRerun}>
            Re-run
          </Button>{" "}
          <Button
            variant="danger"
            onClick={() => {
              setDeleteError(null);
              setDeleteOpen(true);
            }}
          >
            Delete
          </Button>
        </FlexItem>
      </Flex>

      {fetchError && (
        <Alert
          variant={gone ? "warning" : "danger"}
          isInline
          title={gone ? "Playbook run no longer exists" : "Cannot load playbook run"}
          style={{ margin: "1rem 0" }}
        >
          {gone
            ? "It was deleted; its stage AgentRuns are owner-referenced and garbage-collected with it."
            : fetchError}
        </Alert>
      )}

      {run === null && !fetchError ? (
        <Bullseye>
          <Spinner aria-label="Loading playbook run" />
        </Bullseye>
      ) : run !== null ? (
        <>
          <DescriptionList columnModifier={{ default: "2Col" }} isCompact style={{ margin: "1rem 0" }}>
            <DescriptionListGroup>
              <DescriptionListTerm>Playbook</DescriptionListTerm>
              <DescriptionListDescription>{run.spec.playbookRef}</DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Current stage</DescriptionListTerm>
              <DescriptionListDescription>
                {run.status?.currentStage ?? "—"}
              </DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Age</DescriptionListTerm>
              <DescriptionListDescription>
                {formatAge(run.metadata.creationTimestamp)}
              </DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Duration</DescriptionListTerm>
              <DescriptionListDescription>
                {duration !== undefined ? `${Math.floor(duration / 60)}m${String(duration % 60).padStart(2, "0")}s` : "—"}
              </DescriptionListDescription>
            </DescriptionListGroup>
          </DescriptionList>

          <Title headingLevel="h3" size="lg" style={{ margin: "1rem 0 0.5rem" }}>
            Run spec
          </Title>
          <DescriptionList isHorizontal isCompact>
            <DescriptionListGroup>
              <DescriptionListTerm>Params</DescriptionListTerm>
              <DescriptionListDescription>
                {params.length === 0
                  ? "—"
                  : params.map((p) => (
                      <Label key={p.name} isCompact variant="outline" style={{ marginRight: "0.5rem" }}>
                        <code>
                          {p.name}={p.value}
                        </code>
                      </Label>
                    ))}
              </DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Models</DescriptionListTerm>
              <DescriptionListDescription>
                {models.length === 0
                  ? "—"
                  : models.map((m) => (
                      <div key={m.role}>
                        {m.role}: {m.provider} / {m.model}
                      </div>
                    ))}
              </DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Application id</DescriptionListTerm>
              <DescriptionListDescription>{coordinates.appId ?? "—"}</DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Hub base URL</DescriptionListTerm>
              <DescriptionListDescription>
                {coordinates.hubBaseUrl ? <code>{coordinates.hubBaseUrl}</code> : "—"}
              </DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Hub token</DescriptionListTerm>
              <DescriptionListDescription>
                {coordinates.hasToken ? "set (hidden)" : "—"}
              </DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Target branch</DescriptionListTerm>
              <DescriptionListDescription>
                {coordinates.targetBranch ? <code>{coordinates.targetBranch}</code> : "—"}
              </DescriptionListDescription>
            </DescriptionListGroup>
          </DescriptionList>

          <Title headingLevel="h3" size="lg" style={{ margin: "1rem 0 0.5rem" }}>
            Stages
          </Title>
          {stages.length === 0 ? (
            <Alert variant="info" isInline title="No stage status yet">
              The controller has not populated stage status — the playbook may not be Ready.
            </Alert>
          ) : (
            <ProgressStepper aria-label="Playbook stages">
              {stages.map((stage) => (
                <ProgressStep
                  key={stage.name}
                  variant={stepVariant(stage.phase)}
                  isCurrent={stage.name === run.status?.currentStage}
                  id={`stage-${stage.name}`}
                  titleId={`stage-${stage.name}-title`}
                  aria-label={`stage ${stage.name}: ${stage.phase}`}
                  description={
                    stage.agentRunName ? (
                      <Button
                        variant="link"
                        isInline
                        onClick={() => onOpenRun(stage.agentRunName!)}
                      >
                        {stage.phase === "Running" ? "Open live run" : "Open run"}
                      </Button>
                    ) : (
                      stage.phase
                    )
                  }
                >
                  {stage.name}
                </ProgressStep>
              ))}
            </ProgressStepper>
          )}

          {coordinates.targetBranch && (
            <BranchPanel
              application={application}
              targetBranch={coordinates.targetBranch}
              isTerminal={isTerminalPhase(run.status?.phase)}
            />
          )}
        </>
      ) : null}

      {isDeleteOpen && (
        <Modal
          variant={ModalVariant.small}
          isOpen
          onClose={() => {
            if (!deleting) setDeleteOpen(false);
          }}
          aria-labelledby="delete-playbook-run-title"
        >
          <ModalHeader title="Delete AgentPlaybookRun?" labelId="delete-playbook-run-title" />
          <ModalBody>
            {deleteError && (
              <Alert variant="danger" isInline title="Delete failed" style={{ marginBottom: "1rem" }}>
                {deleteError}
              </Alert>
            )}
            Delete playbook run <strong>{name}</strong>? Its stage AgentRuns are owner-referenced
            and garbage-collected with it.
          </ModalBody>
          <ModalFooter>
            <Button
              variant="danger"
              isLoading={deleting}
              isDisabled={deleting}
              onClick={() => void confirmDelete()}
            >
              Delete
            </Button>
            <Button variant="link" isDisabled={deleting} onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
          </ModalFooter>
        </Modal>
      )}

      {isRerunOpen && (
        <Modal
          variant={ModalVariant.small}
          isOpen
          onClose={() => {
            if (!rerunSubmitting) setRerunOpen(false);
          }}
          aria-labelledby="rerun-playbook-run-title"
        >
          <ModalHeader
            title="Re-run (create a new run)"
            labelId="rerun-playbook-run-title"
            description="AgentPlaybookRun specs are immutable, so this creates a new playbook run with the same spec."
          />
          <ModalBody>
            {rerunError && (
              <Alert variant="danger" isInline title="Re-run failed" style={{ marginBottom: "1rem" }}>
                {rerunError}
              </Alert>
            )}
            <Form
              onSubmit={(e) => {
                e.preventDefault();
                void submitRerun();
              }}
            >
              {coordinates.appId && (
                <FormGroup label="Target branch" isRequired fieldId="rerun-playbook-target-branch">
                  <TextInput
                    id="rerun-playbook-target-branch"
                    isRequired
                    value={rerunBranch}
                    validated={rerunBranchReason !== undefined ? "error" : "default"}
                    onChange={(_e, v) => setRerunBranch(v)}
                  />
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem
                        variant={rerunBranchReason !== undefined ? "error" : "default"}
                      >
                        {rerunBranchReason ??
                          "Keep it to continue that branch's work; change it (e.g. Generate new) for a fresh start."}
                      </HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                  <Button
                    variant="link"
                    isInline
                    onClick={() => setRerunBranch(defaultTargetBranch())}
                  >
                    Generate new
                  </Button>
                </FormGroup>
              )}
            </Form>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="primary"
              isDisabled={!canRerun}
              isLoading={rerunSubmitting}
              onClick={() => void submitRerun()}
            >
              Create new run
            </Button>
            <Button variant="link" isDisabled={rerunSubmitting} onClick={() => setRerunOpen(false)}>
              Cancel
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </PageSection>
  );
}
