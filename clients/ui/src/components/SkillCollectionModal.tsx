import { useEffect, useRef, useState } from "react";
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
  TextInput,
} from "@patternfly/react-core";
import AngleUpIcon from "@patternfly/react-icons/dist/esm/icons/angle-up-icon";
import AngleDownIcon from "@patternfly/react-icons/dist/esm/icons/angle-down-icon";
import TimesIcon from "@patternfly/react-icons/dist/esm/icons/times-icon";
import {
  RESOURCE_NAME_MAX,
  RESOURCE_NAME_PATTERN,
} from "@konveyor/agentic-client/contract";
import type {
  SkillCard,
  SkillCollection,
  SkillCollectionSkillRef,
  SkillCollectionSpec,
} from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage } from "../format";

interface SkillCollectionModalProps {
  api: ShimClient;
  /** Edit this collection when set; create a new one when undefined. */
  collection?: SkillCollection;
  onClose: () => void;
  onSaved: (name: string) => void;
}

type MemberKind = "skillCardRef" | "image";

interface MemberRow {
  /** Stable list key, never reused within a modal instance. */
  key: number;
  name: string;
  kind: MemberKind;
  skillCardRef: string;
  image: string;
}

/** Why the collection name cannot be used, or undefined when it can. */
function nameInvalidReason(name: string): string | undefined {
  const n = name.trim();
  if (!n) return "Name is required.";
  if (n.length > RESOURCE_NAME_MAX) {
    return `Name must be at most ${RESOURCE_NAME_MAX} characters.`;
  }
  if (!RESOURCE_NAME_PATTERN.test(n)) {
    return "Must be a lowercase DNS-1123 name: alphanumerics, '-' and '.', starting and ending with an alphanumeric.";
  }
  return undefined;
}

function rowsFrom(skills: SkillCollectionSkillRef[]): MemberRow[] {
  return skills.map((s, i) => ({
    key: i,
    name: s.name,
    // Git-source members are not offered by this form; they land as an
    // image-kind row with an empty value the user must fill (see the
    // warning alert below).
    kind: s.skillCardRef ? "skillCardRef" : "image",
    skillCardRef: s.skillCardRef ?? "",
    image: s.image ?? "",
  }));
}

export function SkillCollectionModal({
  api,
  collection,
  onClose,
  onSaved,
}: SkillCollectionModalProps) {
  const isEdit = collection !== undefined;
  const [name, setName] = useState(collection?.metadata.name ?? "");
  const [version, setVersion] = useState(collection?.spec.version ?? "");
  const [members, setMembers] = useState<MemberRow[]>(() =>
    rowsFrom(collection?.spec.skills ?? []),
  );
  const nextKey = useRef(collection?.spec.skills.length ?? 0);
  const [cards, setCards] = useState<SkillCard[]>([]);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const hadSourceMembers = (collection?.spec.skills ?? []).some(
    (s) => !s.skillCardRef && !s.image && s.source,
  );

  useEffect(() => {
    let disposed = false;
    api
      .listSkillCards()
      .then((list) => {
        if (!disposed) setCards(list);
      })
      .catch((err) => {
        if (!disposed) setCardsError(errorMessage(err));
      });
    return () => {
      disposed = true;
    };
  }, [api]);

  const patchMember = (key: number, patch: Partial<MemberRow>) => {
    setMembers((prev) => prev.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  };

  const moveMember = (index: number, delta: -1 | 1) => {
    setMembers((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [row] = next.splice(index, 1);
      next.splice(to, 0, row);
      return next;
    });
  };

  const addMember = () => {
    setMembers((prev) => [
      ...prev,
      { key: nextKey.current++, name: "", kind: "skillCardRef", skillCardRef: "", image: "" },
    ]);
  };

  const nameError = isEdit ? undefined : nameInvalidReason(name);

  // Visible reasons Save stays disabled, mirroring the CRD rules.
  const memberErrors: string[] = [];
  if (members.length === 0) {
    memberErrors.push("A collection needs at least one member (CRD minimum).");
  }
  const seen = new Set<string>();
  for (const m of members) {
    const n = m.name.trim();
    if (!n) {
      memberErrors.push("Every member needs a local name.");
      break;
    }
    if (seen.has(n)) {
      memberErrors.push(`Member names must be unique ("${n}" repeats).`);
      break;
    }
    seen.add(n);
  }
  for (const m of members) {
    const value = m.kind === "skillCardRef" ? m.skillCardRef : m.image.trim();
    if (!value) {
      memberErrors.push(
        m.kind === "skillCardRef"
          ? "Every skill-card member needs a card selected."
          : "Every direct-image member needs an image reference.",
      );
      break;
    }
  }

  const canSave = !nameError && memberErrors.length === 0 && !submitting;

  const submit = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const spec: SkillCollectionSpec = {
        skills: members.map((m) =>
          m.kind === "skillCardRef"
            ? { name: m.name.trim(), skillCardRef: m.skillCardRef }
            : { name: m.name.trim(), image: m.image.trim() },
        ),
      };
      if (version.trim()) spec.version = version.trim();
      const targetName = isEdit ? (collection.metadata.name ?? "") : name.trim();
      const saved = isEdit
        ? await api.updateSkillCollection(targetName, spec)
        : await api.createSkillCollection(targetName, spec);
      onSaved(saved.metadata.name ?? targetName);
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
      aria-labelledby="skillcollection-modal-title"
    >
      <ModalHeader
        title={isEdit ? "Edit skill collection" : "Create skill collection"}
        labelId="skillcollection-modal-title"
        description="An ordered group of skills that agents mount together; members mount alongside the agent's own skill cards, deduped by name."
      />
      <ModalBody>
        {submitError && (
          <Alert
            variant="danger"
            isInline
            title={isEdit ? "Save failed" : "Create failed"}
            style={{ marginBottom: "1rem" }}
          >
            {submitError}
          </Alert>
        )}
        {cardsError && (
          <Alert
            variant="warning"
            isInline
            title="Failed to load skill cards"
            style={{ marginBottom: "1rem" }}
          >
            {cardsError} — skill-card members cannot be picked until the list loads; direct-image
            members are unaffected.
          </Alert>
        )}
        {hadSourceMembers && (
          <Alert
            variant="warning"
            isInline
            title="This collection has git-source members"
            style={{ marginBottom: "1rem" }}
          >
            Git-source members reconcile NotReady and are not editable here; they appear below as
            direct-image rows with an empty image. Fill in an image (or remove them) before
            saving — saving replaces their git source.
          </Alert>
        )}
        <Form
          id="skillcollection-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FormGroup label="Name" isRequired fieldId="skillcollection-name">
            <TextInput
              id="skillcollection-name"
              isRequired
              isDisabled={isEdit}
              value={name}
              validated={!isEdit && name.trim() && nameError ? "error" : "default"}
              onChange={(_e, v) => setName(v)}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant={!isEdit && name.trim() && nameError ? "error" : "default"}>
                  {isEdit
                    ? "Resource names are immutable."
                    : (nameError && name.trim()
                        ? nameError
                        : "Kubernetes object name for the SkillCollection.")}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label="Version" fieldId="skillcollection-version">
            <TextInput
              id="skillcollection-version"
              value={version}
              onChange={(_e, v) => setVersion(v)}
            />
          </FormGroup>

          <FormGroup label="Members" isRequired fieldId="skillcollection-members" role="group">
            {members.map((m, i) => (
              <div
                key={m.key}
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "center",
                  marginBottom: "0.5rem",
                }}
              >
                <TextInput
                  id={`member-name-${m.key}`}
                  aria-label={`Member ${i + 1} name`}
                  placeholder="name"
                  value={m.name}
                  onChange={(_e, v) => patchMember(m.key, { name: v })}
                  style={{ maxWidth: "10rem" }}
                />
                <FormSelect
                  id={`member-kind-${m.key}`}
                  aria-label={`Member ${i + 1} kind`}
                  value={m.kind}
                  onChange={(_e, v) => patchMember(m.key, { kind: v as MemberKind })}
                  style={{ maxWidth: "9rem" }}
                >
                  <FormSelectOption value="skillCardRef" label="Skill card" />
                  <FormSelectOption value="image" label="Direct image" />
                </FormSelect>
                {m.kind === "skillCardRef" ? (
                  <FormSelect
                    id={`member-card-${m.key}`}
                    aria-label={`Member ${i + 1} skill card`}
                    value={m.skillCardRef}
                    onChange={(_e, v) => patchMember(m.key, { skillCardRef: v })}
                  >
                    <FormSelectOption value="" label="Select a skill card" />
                    {cards.map((c) => {
                      const cardName = c.metadata.name ?? "";
                      return (
                        <FormSelectOption
                          key={cardName}
                          value={cardName}
                          label={
                            c.spec.displayName ? `${cardName} — ${c.spec.displayName}` : cardName
                          }
                        />
                      );
                    })}
                  </FormSelect>
                ) : (
                  <TextInput
                    id={`member-image-${m.key}`}
                    aria-label={`Member ${i + 1} image`}
                    placeholder="quay.io/konveyor/skills:analyze"
                    value={m.image}
                    onChange={(_e, v) => patchMember(m.key, { image: v })}
                  />
                )}
                <Button
                  variant="plain"
                  aria-label={`Move member ${i + 1} up`}
                  icon={<AngleUpIcon />}
                  isDisabled={i === 0}
                  onClick={() => moveMember(i, -1)}
                />
                <Button
                  variant="plain"
                  aria-label={`Move member ${i + 1} down`}
                  icon={<AngleDownIcon />}
                  isDisabled={i === members.length - 1}
                  onClick={() => moveMember(i, 1)}
                />
                <Button
                  variant="plain"
                  aria-label={`Remove member ${i + 1}`}
                  icon={<TimesIcon />}
                  onClick={() => setMembers((prev) => prev.filter((row) => row.key !== m.key))}
                />
              </div>
            ))}
            <Button variant="secondary" onClick={addMember}>
              Add member
            </Button>
            <FormHelperText>
              <HelperText>
                {memberErrors.length > 0 ? (
                  memberErrors.map((err) => (
                    <HelperTextItem key={err} variant="error">
                      {err}
                    </HelperTextItem>
                  ))
                ) : (
                  <HelperTextItem>
                    Members with a direct image need no SkillCard CR. Git-source members exist in
                    the CRD but reconcile NotReady and are not offered here.
                  </HelperTextItem>
                )}
              </HelperText>
            </FormHelperText>
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
