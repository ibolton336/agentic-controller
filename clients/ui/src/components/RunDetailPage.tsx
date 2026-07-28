import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  ExpandableSection,
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
  TextInput,
  Title,
} from "@patternfly/react-core";
import ArrowLeftIcon from "@patternfly/react-icons/dist/esm/icons/arrow-left-icon";
import type { AgentRun } from "@konveyor/agentic-client/contract";
import { defaultTargetBranch, isTerminalPhase } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, formatAge, formatDuration } from "../format";
import { PhaseLabel } from "./PhaseLabel";
import { ChatPanel } from "./ChatPanel";
import { BranchPanel } from "./BranchPanel";
import { runHubCoordinates, useApplicationInventory } from "./sources";

const POLL_MS = 2_000;

interface RunDetailPageProps {
  api: ShimClient;
  runName: string;
  onBack: () => void;
  /** Called after the run is successfully deleted. */
  onDeleted: () => void;
  /** Navigate to the new run a re-run created. */
  onRerun: (newRunName: string) => void;
}

export function RunDetailPage({ api, runName, onBack, onDeleted, onRerun }: RunDetailPageProps) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [isDeleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [isRerunOpen, setRerunOpen] = useState(false);
  const [rerunBranch, setRerunBranch] = useState("");
  const [rerunSubmitting, setRerunSubmitting] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  // Inventory failures leave `application` undefined — BranchPanel copes.
  const inventory = useApplicationInventory(api);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let stopped = false;
    const tick = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const r = await api.getRun(runName);
        if (!disposed) {
          setRun(r);
          setError(null);
        }
      } catch (err) {
        if (!disposed) {
          const msg = errorMessage(err);
          if (msg.includes("HTTP 404")) {
            setNotFound(true);
            stopped = true; // gone for good — no point polling on
          } else {
            setError(msg);
          }
        }
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [api, runName]);

  const coordinates = runHubCoordinates(run?.spec.env);
  const application = inventory.applications.find((a) => a.id === coordinates.appId);
  const instructions = run?.spec.instructions;
  const params = run?.spec.params ?? [];
  const models = run?.spec.models ?? [];

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteRun(runName);
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

  const canRerun =
    run !== null && (!coordinates.appId || rerunBranch.trim() !== "") && !rerunSubmitting;

  const submitRerun = async () => {
    if (!run || !canRerun) return;
    setRerunSubmitting(true);
    setRerunError(null);
    try {
      const rerunParams = Object.fromEntries((run.spec.params ?? []).map((p) => [p.name, p.value]));
      const primary = run.spec.models?.find((m) => m.role === "primary");
      const created = await api.createRun({
        agentRef: run.spec.agentRef,
        params: Object.keys(rerunParams).length > 0 ? rerunParams : undefined,
        instructions: run.spec.instructions,
        applicationRef: coordinates.appId,
        targetBranch: coordinates.appId ? rerunBranch.trim() : undefined,
        model: primary ? { provider: primary.provider, model: primary.model } : undefined,
      });
      const name = created.metadata.name;
      if (!name) throw new Error("shim returned a created run without metadata.name");
      onRerun(name);
    } catch (err) {
      setRerunError(errorMessage(err));
      setRerunSubmitting(false);
    }
  };

  if (notFound) {
    return (
      <PageSection>
        <Alert variant="warning" isInline title={`AgentRun "${runName}" not found`}>
          It may have been deleted.
        </Alert>
        <Button variant="link" isInline icon={<ArrowLeftIcon />} onClick={onBack} style={{ marginTop: "1rem" }}>
          Back to runs
        </Button>
      </PageSection>
    );
  }

  return (
    <>
      <PageSection>
        <Button variant="link" isInline icon={<ArrowLeftIcon />} onClick={onBack}>
          Back to runs
        </Button>
        <Flex
          alignItems={{ default: "alignItemsCenter" }}
          spaceItems={{ default: "spaceItemsMd" }}
          style={{ marginTop: "0.5rem" }}
        >
          <FlexItem>
            <Title headingLevel="h2" size="xl">
              {runName}
            </Title>
          </FlexItem>
          <FlexItem>
            <PhaseLabel phase={run?.status?.phase} />
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
        {error && (
          <Alert variant="danger" isInline title="Failed to refresh run" style={{ marginTop: "0.75rem" }}>
            {error}
          </Alert>
        )}
        <DescriptionList
          isHorizontal
          isCompact
          columnModifier={{ default: "2Col" }}
          style={{ marginTop: "0.75rem" }}
        >
          <DescriptionListGroup>
            <DescriptionListTerm>Agent</DescriptionListTerm>
            <DescriptionListDescription>{run?.spec.agentRef ?? "—"}</DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Sandbox</DescriptionListTerm>
            <DescriptionListDescription>{run?.status?.sandboxName ?? "—"}</DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Age</DescriptionListTerm>
            <DescriptionListDescription>
              {formatAge(run?.metadata.creationTimestamp)}
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Duration</DescriptionListTerm>
            <DescriptionListDescription>
              {formatDuration(run?.status?.duration)}
            </DescriptionListDescription>
          </DescriptionListGroup>
        </DescriptionList>

        <Title headingLevel="h3" size="lg" style={{ marginTop: "1rem" }}>
          Run spec
        </Title>
        <DescriptionList isHorizontal isCompact style={{ marginTop: "0.5rem" }}>
          <DescriptionListGroup>
            <DescriptionListTerm>Instructions</DescriptionListTerm>
            <DescriptionListDescription>
              {!instructions ? (
                "—"
              ) : instructions.length > 120 ? (
                <ExpandableSection toggleText="Instructions">{instructions}</ExpandableSection>
              ) : (
                instructions
              )}
            </DescriptionListDescription>
          </DescriptionListGroup>
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

        {coordinates.targetBranch && (
          <BranchPanel
            application={application}
            targetBranch={coordinates.targetBranch}
            isTerminal={isTerminalPhase(run?.status?.phase)}
          />
        )}
      </PageSection>
      <PageSection isFilled className="run-detail-chat-section">
        <ChatPanel api={api} runName={runName} />
      </PageSection>

      {isDeleteOpen && (
        <Modal
          variant={ModalVariant.small}
          isOpen
          onClose={() => {
            if (!deleting) setDeleteOpen(false);
          }}
          aria-labelledby="delete-run-detail-title"
        >
          <ModalHeader title="Delete AgentRun?" labelId="delete-run-detail-title" />
          <ModalBody>
            {deleteError && (
              <Alert variant="danger" isInline title="Delete failed" style={{ marginBottom: "1rem" }}>
                {deleteError}
              </Alert>
            )}
            Delete run <strong>{runName}</strong>? Its sandbox pod and ACP session go with it.
            AgentRun specs are immutable, so re-running means creating a new run.
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
          aria-labelledby="rerun-run-title"
        >
          <ModalHeader
            title="Re-run (create a new run)"
            labelId="rerun-run-title"
            description="AgentRun specs are immutable, so this creates a new run with the same spec."
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
                <FormGroup label="Target branch" isRequired fieldId="rerun-target-branch">
                  <TextInput
                    id="rerun-target-branch"
                    isRequired
                    value={rerunBranch}
                    validated={rerunBranch.trim() === "" ? "error" : "default"}
                    onChange={(_e, v) => setRerunBranch(v)}
                  />
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem variant={rerunBranch.trim() === "" ? "error" : "default"}>
                        {rerunBranch.trim() === ""
                          ? "Required."
                          : "Keep it to continue that branch's work; change it (e.g. Generate new) for a fresh start."}
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
    </>
  );
}
