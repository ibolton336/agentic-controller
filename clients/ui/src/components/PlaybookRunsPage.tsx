import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Bullseye,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  PageSection,
  Spinner,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from "@patternfly/react-core";
import { ActionsColumn, Table, Tbody, Td, Th, Thead, Tr } from "@patternfly/react-table";
import CubesIcon from "@patternfly/react-icons/dist/esm/icons/cubes-icon";
import type { AgentPlaybookRun } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, formatAge } from "../format";
import { PhaseLabel } from "./PhaseLabel";
import { CreatePlaybookRunModal } from "./CreatePlaybookRunModal";
import { LoadDefaultsButton } from "./LoadDefaultsButton";

const POLL_MS = 2_000;

/** Playbook-run status has no duration field — derive it from timestamps. */
export function playbookDuration(run: AgentPlaybookRun): number | undefined {
  const start = run.status?.startTime;
  if (!start) return undefined;
  const end = run.status?.completionTime;
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  return ms >= 0 ? Math.round(ms / 1000) : undefined;
}

function formatSeconds(seconds?: number): string {
  if (seconds === undefined) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

interface PlaybookRunsPageProps {
  api: ShimClient;
  onOpenPlaybookRun: (name: string) => void;
}

export function PlaybookRunsPage({ api, onOpenPlaybookRun }: PlaybookRunsPageProps) {
  const [runs, setRuns] = useState<AgentPlaybookRun[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isCreateOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const list = await api.listPlaybookRuns();
      list.sort((a, b) =>
        (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""),
      );
      setRuns(list);
      setFetchError(null);
    } catch (err) {
      setFetchError(errorMessage(err));
    } finally {
      inFlight.current = false;
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deletePlaybookRun(deleteTarget);
      setDeleteTarget(null);
      void refresh();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <PageSection>
      <Title headingLevel="h2" size="xl">
        Playbook runs
      </Title>
      <Toolbar inset={{ default: "insetNone" }}>
        <ToolbarContent>
          <ToolbarItem>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              Create playbook run
            </Button>
          </ToolbarItem>
          <ToolbarItem>
            <LoadDefaultsButton api={api} />
          </ToolbarItem>
        </ToolbarContent>
      </Toolbar>
      {fetchError && (
        <Alert
          variant="danger"
          isInline
          title="Cannot reach the hub-shim"
          style={{ margin: "1rem 0" }}
        >
          {fetchError}
        </Alert>
      )}
      {runs === null && !fetchError ? (
        <Bullseye>
          <Spinner aria-label="Loading playbook runs" />
        </Bullseye>
      ) : runs !== null && runs.length === 0 ? (
        <EmptyState titleText="No playbook runs" headingLevel="h3" icon={CubesIcon}>
          <EmptyStateBody>
            No AgentPlaybookRuns exist yet. Create one against an AgentPlaybook; each stage runs as
            its own AgentRun, in order.
          </EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                Create playbook run
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
        </EmptyState>
      ) : runs !== null ? (
        <Table aria-label="Playbook runs" variant="compact">
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Playbook</Th>
              <Th>Phase</Th>
              <Th>Stages</Th>
              <Th>Age</Th>
              <Th>Duration</Th>
              <Th screenReaderText="Actions" />
            </Tr>
          </Thead>
          <Tbody>
            {runs.map((run) => {
              const name = run.metadata.name ?? "";
              const stages = run.status?.stages ?? [];
              const done = stages.filter((s) => s.phase === "Succeeded").length;
              const current = run.status?.currentStage;
              return (
                <Tr key={run.metadata.uid ?? name}>
                  <Td dataLabel="Name">
                    <Button variant="link" isInline onClick={() => onOpenPlaybookRun(name)}>
                      {name}
                    </Button>
                  </Td>
                  <Td dataLabel="Playbook">{run.spec.playbookRef}</Td>
                  <Td dataLabel="Phase">
                    <PhaseLabel phase={run.status?.phase} />
                  </Td>
                  <Td dataLabel="Stages">
                    {stages.length > 0
                      ? `${done}/${stages.length}${current ? ` · ${current}` : ""}`
                      : "—"}
                  </Td>
                  <Td dataLabel="Age">{formatAge(run.metadata.creationTimestamp)}</Td>
                  <Td dataLabel="Duration">{formatSeconds(playbookDuration(run))}</Td>
                  <Td isActionCell>
                    <ActionsColumn
                      items={[
                        {
                          title: "Delete",
                          onClick: () => {
                            setDeleteError(null);
                            setDeleteTarget(name);
                          },
                        },
                      ]}
                    />
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
      ) : null}

      {isCreateOpen && (
        <CreatePlaybookRunModal
          api={api}
          onClose={() => setCreateOpen(false)}
          onCreated={(name) => {
            setCreateOpen(false);
            onOpenPlaybookRun(name);
          }}
        />
      )}

      <Modal
        variant={ModalVariant.small}
        isOpen={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        aria-labelledby="delete-playbook-run-list-title"
      >
        <ModalHeader title="Delete AgentPlaybookRun?" labelId="delete-playbook-run-list-title" />
        <ModalBody>
          {deleteError && (
            <Alert
              variant="danger"
              isInline
              title="Delete failed"
              style={{ marginBottom: "1rem" }}
            >
              {deleteError}
            </Alert>
          )}
          Delete playbook run <strong>{deleteTarget}</strong>? Its stage AgentRuns are
          owner-referenced and cascade with it via ownerRefs.
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
          <Button variant="link" isDisabled={deleting} onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </PageSection>
  );
}
