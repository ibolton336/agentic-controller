import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Bullseye,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  Label,
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
import { MANAGED_LABEL } from "@konveyor/agentic-client/contract";
import type { AgentResource } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, formatAge, truncate } from "../format";
import { ReadyLabel, skillCount } from "./sources";
import { AgentDesignerModal } from "./AgentDesignerModal";

const POLL_MS = 2_000;

export function AgentsPage({ api }: { api: ShimClient }) {
  const [agents, setAgents] = useState<AgentResource[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Designer modal: null = closed, {} = create, {agent} = edit.
  const [designer, setDesigner] = useState<{ agent?: AgentResource } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const list = await api.listAgents();
      list.sort((a, b) => (a.metadata.name ?? "").localeCompare(b.metadata.name ?? ""));
      setAgents(list);
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
      await api.deleteAgent(deleteTarget);
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
          Agents
        </Title>
        <Toolbar inset={{ default: "insetNone" }}>
          <ToolbarContent>
            <ToolbarItem>
              <Button variant="primary" onClick={() => setDesigner({})}>
                Create agent
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        <div style={{ marginBottom: "1rem", opacity: 0.7 }}>
          Only agents labeled <code>{MANAGED_LABEL}=true</code> are listed; agents created here
          are stamped automatically.
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
        {agents === null && !fetchError ? (
          <Bullseye>
            <Spinner aria-label="Loading agents" />
          </Bullseye>
        ) : agents !== null && agents.length === 0 ? (
          <EmptyState titleText="No agents" headingLevel="h3" icon={CubesIcon}>
            <EmptyStateBody>
              No managed Agent templates exist yet. Create one to make it runnable from the run
              launcher.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={() => setDesigner({})}>
                  Create agent
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : agents !== null ? (
          <Table aria-label="Agents" variant="compact">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Image</Th>
                <Th>Providers</Th>
                <Th>Skills</Th>
                <Th>Params</Th>
                <Th>Ready</Th>
                <Th>Age</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {agents.map((agent) => {
                const name = agent.metadata.name ?? "";
                const skills = skillCount(agent);
                const paramCount = agent.spec.params?.length ?? 0;
                return (
                  <Tr key={agent.metadata.uid ?? name}>
                    <Td dataLabel="Name">{name}</Td>
                    <Td dataLabel="Image">
                      <code>{truncate(agent.spec.image ?? "", 50)}</code>
                    </Td>
                    <Td dataLabel="Providers">
                      {agent.spec.providers?.map((p) => p.ref).join(", ") || "—"}
                    </Td>
                    <Td dataLabel="Skills">
                      {skills === 0 ? (
                        <Label
                          isCompact
                          color="red"
                          title="The migration-harness fails fatally when an agent mounts zero skills; only fixtures like the mock harness legitimately run skill-less."
                        >
                          0 — runs fatal
                        </Label>
                      ) : (
                        skills
                      )}
                    </Td>
                    <Td dataLabel="Params">{paramCount > 0 ? paramCount : "—"}</Td>
                    <Td dataLabel="Ready">
                      <ReadyLabel resource={agent} />
                    </Td>
                    <Td dataLabel="Age">{formatAge(agent.metadata.creationTimestamp)}</Td>
                    <Td isActionCell>
                      <ActionsColumn
                        items={[
                          {
                            title: "Edit",
                            onClick: () => setDesigner({ agent }),
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

      {designer && (
        <AgentDesignerModal
          api={api}
          agent={designer.agent}
          onClose={() => setDesigner(null)}
          onSaved={() => {
            setDesigner(null);
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
        aria-labelledby="delete-agent-title"
      >
        <ModalHeader title="Delete Agent?" labelId="delete-agent-title" />
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
          Delete agent <strong>{deleteTarget}</strong>? Existing runs keep going, but new runs of
          it cannot be created — and playbook stages referencing this agent will fail run
          creation.
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
