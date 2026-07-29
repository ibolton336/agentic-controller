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
import type { SkillCard, SkillCollection } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, formatAge, truncate } from "../format";
import { ReadyLabel } from "./sources";
import { SkillCardModal } from "./SkillCardModal";
import { SkillCollectionModal } from "./SkillCollectionModal";

const POLL_MS = 2_000;
const MAX_SHOWN_TAGS = 3;

/** Which of the mutually-exclusive SkillCard source fields is set. */
function cardSource(card: SkillCard): string {
  if (card.spec.image) return "image";
  if (card.spec.inline) return "inline (not ready)";
  if (card.spec.source) return "git (not ready)";
  return "—";
}

export function SkillsPage({ api }: { api: ShimClient }) {
  const [cards, setCards] = useState<SkillCard[] | null>(null);
  const [collections, setCollections] = useState<SkillCollection[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Modal state: null = closed; { card: undefined } = create; { card } = edit.
  const [cardModal, setCardModal] = useState<{ card?: SkillCard } | null>(null);
  const [collectionModal, setCollectionModal] = useState<{
    collection?: SkillCollection;
  } | null>(null);

  const [deleteCardTarget, setDeleteCardTarget] = useState<string | null>(null);
  const [deletingCard, setDeletingCard] = useState(false);
  const [deleteCardError, setDeleteCardError] = useState<string | null>(null);

  const [deleteCollectionTarget, setDeleteCollectionTarget] = useState<string | null>(null);
  const [deletingCollection, setDeletingCollection] = useState(false);
  const [deleteCollectionError, setDeleteCollectionError] = useState<string | null>(null);

  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [cardList, collectionList] = await Promise.all([
        api.listSkillCards(),
        api.listSkillCollections(),
      ]);
      const byName = (a: { metadata: { name?: string } }, b: { metadata: { name?: string } }) =>
        (a.metadata.name ?? "").localeCompare(b.metadata.name ?? "");
      cardList.sort(byName);
      collectionList.sort(byName);
      setCards(cardList);
      setCollections(collectionList);
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

  const confirmDeleteCard = async () => {
    if (!deleteCardTarget) return;
    setDeletingCard(true);
    setDeleteCardError(null);
    try {
      await api.deleteSkillCard(deleteCardTarget);
      setDeleteCardTarget(null);
      void refresh();
    } catch (err) {
      setDeleteCardError(errorMessage(err));
    } finally {
      setDeletingCard(false);
    }
  };

  const confirmDeleteCollection = async () => {
    if (!deleteCollectionTarget) return;
    setDeletingCollection(true);
    setDeleteCollectionError(null);
    try {
      await api.deleteSkillCollection(deleteCollectionTarget);
      setDeleteCollectionTarget(null);
      void refresh();
    } catch (err) {
      setDeleteCollectionError(errorMessage(err));
    } finally {
      setDeletingCollection(false);
    }
  };

  const loading = cards === null && collections === null && !fetchError;

  return (
    <>
      <PageSection>
        <Alert
          variant="info"
          isInline
          isPlain
          title="Only resources labeled konveyor.io/managed=true are listed here; anything created through this page is stamped with that label automatically."
          style={{ marginBottom: "1rem" }}
        />
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

        <Title headingLevel="h2" size="xl">
          Skill cards
        </Title>
        <Toolbar inset={{ default: "insetNone" }}>
          <ToolbarContent>
            <ToolbarItem>
              <Button variant="primary" onClick={() => setCardModal({})}>
                Create skill card
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        {loading ? (
          <Bullseye>
            <Spinner aria-label="Loading skill cards" />
          </Bullseye>
        ) : cards !== null && cards.length === 0 ? (
          <EmptyState titleText="No skill cards" headingLevel="h3" icon={CubesIcon}>
            <EmptyStateBody>
              No managed SkillCards exist yet. Create one to make a skill mountable by agents at
              /opt/skills.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={() => setCardModal({})}>
                  Create skill card
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : cards !== null ? (
          <Table aria-label="Skill cards" variant="compact">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Display name</Th>
                <Th>Type</Th>
                <Th>Source</Th>
                <Th>Ready</Th>
                <Th>Resolved image</Th>
                <Th>Tags</Th>
                <Th>Age</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {cards.map((card) => {
                const name = card.metadata.name ?? "";
                const type = card.spec.type ?? "skill";
                const tags = card.spec.tags ?? [];
                return (
                  <Tr key={card.metadata.uid ?? name}>
                    <Td dataLabel="Name">{name}</Td>
                    <Td dataLabel="Display name">{card.spec.displayName ?? "—"}</Td>
                    <Td dataLabel="Type">
                      <Label
                        isCompact
                        color={type === "rule" ? "orange" : "grey"}
                        title={
                          type === "rule"
                            ? "Rules are always loaded into every LLM turn and count against its context budget"
                            : "Skills load on demand when the agent invokes them"
                        }
                      >
                        {type}
                      </Label>
                    </Td>
                    <Td dataLabel="Source">{cardSource(card)}</Td>
                    <Td dataLabel="Ready">
                      <ReadyLabel resource={card} />
                    </Td>
                    <Td dataLabel="Resolved image">
                      {card.status?.resolvedImage ? (
                        <code>{truncate(card.status.resolvedImage, 50)}</code>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td dataLabel="Tags">
                      {tags.length === 0
                        ? "—"
                        : tags.slice(0, MAX_SHOWN_TAGS).map((tag) => (
                            <Label
                              key={tag}
                              isCompact
                              color="grey"
                              style={{ marginRight: "0.25rem" }}
                            >
                              {tag}
                            </Label>
                          ))}
                      {tags.length > MAX_SHOWN_TAGS && (
                        <span title={tags.slice(MAX_SHOWN_TAGS).join(", ")}>
                          +{tags.length - MAX_SHOWN_TAGS}
                        </span>
                      )}
                    </Td>
                    <Td dataLabel="Age">{formatAge(card.metadata.creationTimestamp)}</Td>
                    <Td isActionCell>
                      <ActionsColumn
                        items={[
                          {
                            title: "Edit",
                            onClick: () => setCardModal({ card }),
                          },
                          {
                            title: "Delete",
                            onClick: () => {
                              setDeleteCardError(null);
                              setDeleteCardTarget(name);
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

        <Title headingLevel="h2" size="xl" style={{ marginTop: "2rem" }}>
          Skill collections
        </Title>
        <Toolbar inset={{ default: "insetNone" }}>
          <ToolbarContent>
            <ToolbarItem>
              <Button variant="primary" onClick={() => setCollectionModal({})}>
                Create skill collection
              </Button>
            </ToolbarItem>
          </ToolbarContent>
        </Toolbar>
        {loading ? (
          <Bullseye>
            <Spinner aria-label="Loading skill collections" />
          </Bullseye>
        ) : collections !== null && collections.length === 0 ? (
          <EmptyState titleText="No skill collections" headingLevel="h3" icon={CubesIcon}>
            <EmptyStateBody>
              No managed SkillCollections exist yet. Create one to group skills that agents mount
              together.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={() => setCollectionModal({})}>
                  Create skill collection
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        ) : collections !== null ? (
          <Table aria-label="Skill collections" variant="compact">
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Skills</Th>
                <Th>Ready</Th>
                <Th>Age</Th>
                <Th screenReaderText="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {collections.map((collection) => {
                const name = collection.metadata.name ?? "";
                const skills = collection.spec.skills ?? [];
                return (
                  <Tr key={collection.metadata.uid ?? name}>
                    <Td dataLabel="Name">{name}</Td>
                    <Td dataLabel="Skills">
                      {skills.length} — {truncate(skills.map((s) => s.name).join(", "), 60)}
                    </Td>
                    <Td dataLabel="Ready">
                      <ReadyLabel resource={collection} />
                    </Td>
                    <Td dataLabel="Age">{formatAge(collection.metadata.creationTimestamp)}</Td>
                    <Td isActionCell>
                      <ActionsColumn
                        items={[
                          {
                            title: "Edit",
                            onClick: () => setCollectionModal({ collection }),
                          },
                          {
                            title: "Delete",
                            onClick: () => {
                              setDeleteCollectionError(null);
                              setDeleteCollectionTarget(name);
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

      {cardModal && (
        <SkillCardModal
          api={api}
          card={cardModal.card}
          onClose={() => setCardModal(null)}
          onSaved={() => {
            setCardModal(null);
            void refresh();
          }}
        />
      )}

      {collectionModal && (
        <SkillCollectionModal
          api={api}
          collection={collectionModal.collection}
          onClose={() => setCollectionModal(null)}
          onSaved={() => {
            setCollectionModal(null);
            void refresh();
          }}
        />
      )}

      <Modal
        variant={ModalVariant.small}
        isOpen={deleteCardTarget !== null}
        onClose={() => {
          if (!deletingCard) setDeleteCardTarget(null);
        }}
        aria-labelledby="delete-skillcard-title"
      >
        <ModalHeader title="Delete skill card?" labelId="delete-skillcard-title" />
        <ModalBody>
          {deleteCardError && (
            <Alert
              variant="danger"
              isInline
              title="Delete failed"
              style={{ marginBottom: "1rem" }}
            >
              {deleteCardError}
            </Alert>
          )}
          Delete skill card <strong>{deleteCardTarget}</strong>? Agents that still reference it
          keep their reference, and their runs fail skill resolution at create time until the
          reference is removed or the card is recreated.
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            isLoading={deletingCard}
            isDisabled={deletingCard}
            onClick={() => void confirmDeleteCard()}
          >
            Delete
          </Button>
          <Button variant="link" isDisabled={deletingCard} onClick={() => setDeleteCardTarget(null)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      <Modal
        variant={ModalVariant.small}
        isOpen={deleteCollectionTarget !== null}
        onClose={() => {
          if (!deletingCollection) setDeleteCollectionTarget(null);
        }}
        aria-labelledby="delete-skillcollection-title"
      >
        <ModalHeader title="Delete skill collection?" labelId="delete-skillcollection-title" />
        <ModalBody>
          {deleteCollectionError && (
            <Alert
              variant="danger"
              isInline
              title="Delete failed"
              style={{ marginBottom: "1rem" }}
            >
              {deleteCollectionError}
            </Alert>
          )}
          Delete skill collection <strong>{deleteCollectionTarget}</strong>? Agents that still
          reference it fail skill resolution at run-create time until the reference is removed or
          the collection is recreated.
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            isLoading={deletingCollection}
            isDisabled={deletingCollection}
            onClick={() => void confirmDeleteCollection()}
          >
            Delete
          </Button>
          <Button
            variant="link"
            isDisabled={deletingCollection}
            onClick={() => setDeleteCollectionTarget(null)}
          >
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
