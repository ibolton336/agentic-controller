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
import type { AgentPlaybook } from "@konveyor/agentic-client/contract";
import { MANAGED_LABEL } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, formatAge, truncate } from "../format";
import { ReadyLabel } from "./sources";
import { PlaybookComposerModal } from "./PlaybookComposerModal";

const POLL_MS = 2_000;

/** "3: plan → execute → verify", truncated. */
function stagesSummary(pb: AgentPlaybook): string {
  const names = pb.spec.stages.map((s) => s.name);
  return truncate(`${names.length}: ${names.join(" → ")}`, 70);
}

export function PlaybooksPage({ api }: { api: ShimClient }) {
  const [playbooks, setPlaybooks] = useState<AgentPlaybook[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // null = closed; {} = create; {playbook} = edit.
  const [composer, setComposer] = useState<{ playbook?: AgentPlaybook } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const list = await api.listPlaybooks();
      list.sort((a, b) => (a.metadata.name ?? "").localeCompare(b.metadata.name ?? ""));
      setPlaybooks(list);
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
      await api.deletePlaybook(deleteTarget);
      setDeleteTarget(null);
      void refresh();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <PageSection>
        <Title headingLevel="h2" size="xl">
          Playbooks
        </Title>
        <Toolbar inset={{ default: "insetNone" }}>
          <ToolbarContent>
            <ToolbarItem>
              <Button variant="primary" onClick={() => setComposer({})}>
                Create playbook
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        <div style={{ marginBottom: "1rem", fontSize: "0.85rem", opacity: 0.7 }}>
          Listing playbooks labeled <code>{MANAGED_LABEL}=true</code> — everything created or
          edited here is stamped automatically; unlabeled playbooks are not shown.
        </div>
        {fetchError && (
          <Alert
            variant="danger"
            isInline
            title="Cannot reach the hub-shim"
            style={{ marginBottom: "1rem" }}
          >
            {fetchError}
          </Alert>
        )}
        {playbooks === null && !fetchError ? (
          <Bullseye>
            <Spinner aria-label="Loading playbooks" />
          </Bullseye>
        ) : playbooks !== null && playbooks.length === 0 ? (
          <EmptyState titleText="No playbooks" headingLevel="h3" icon={CubesIcon}>
            <EmptyStateBody>
              No managed AgentPlaybooks exist yet. A playbook is a reusable multi-stage template —
              creating one executes nothing until a playbook run references it.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={() => setComposer({})}>
                  Create playbook
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : playbooks !== null ? (
          <Table aria-label="Playbooks" variant="compact">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Stages</Th>
                <Th>Guide</Th>
                <Th>Ready</Th>
                <Th>Age</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {playbooks.map((pb) => {
                const name = pb.metadata.name ?? "";
                return (
                  <Tr key={pb.metadata.uid ?? name}>
                    <Td dataLabel="Name">{name}</Td>
                    <Td dataLabel="Stages">{stagesSummary(pb)}</Td>
                    <Td dataLabel="Guide">
                      {pb.spec.guide ? truncate(pb.spec.guide, 60) : "—"}
                    </Td>
                    <Td dataLabel="Ready">
                      <ReadyLabel resource={pb} />
                    </Td>
                    <Td dataLabel="Age">{formatAge(pb.metadata.creationTimestamp)}</Td>
                    <Td isActionCell>
                      <ActionsColumn
                        items={[
                          {
                            title: "Edit",
                            onClick: () => setComposer({ playbook: pb }),
                          },
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
      </PageSection>

      {composer && (
        <PlaybookComposerModal
          api={api}
          playbook={composer.playbook}
          onClose={() => setComposer(null)}
          onSaved={() => {
            setComposer(null);
            void refresh();
          }}
        />
      )}

      <Modal
        variant={ModalVariant.small}
        isOpen={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        aria-labelledby="delete-playbook-title"
      >
        <ModalHeader title="Delete playbook?" labelId="delete-playbook-title" />
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
          Delete playbook <strong>{deleteTarget}</strong>? In-flight AgentPlaybookRuns that
          reference it will fail to create their remaining stages. Completed runs and their
          artifacts are unaffected.
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
    </>
  );
}
