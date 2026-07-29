import { useState } from "react";
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
import {
  RESOURCE_NAME_MAX,
  RESOURCE_NAME_PATTERN,
} from "@konveyor/agentic-client/contract";
import type { SkillCard, SkillCardSpec, SkillCardType } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage } from "../format";

interface SkillCardModalProps {
  api: ShimClient;
  /** Edit this card when set; create a new one when undefined. */
  card?: SkillCard;
  onClose: () => void;
  onSaved: (name: string) => void;
}

/** Why the name cannot be used, or undefined when it can. */
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

export function SkillCardModal({ api, card, onClose, onSaved }: SkillCardModalProps) {
  const isEdit = card !== undefined;
  const [name, setName] = useState(card?.metadata.name ?? "");
  const [displayName, setDisplayName] = useState(card?.spec.displayName ?? "");
  const [description, setDescription] = useState(card?.spec.description ?? "");
  const [type, setType] = useState<SkillCardType>(card?.spec.type ?? "skill");
  const [image, setImage] = useState(card?.spec.image ?? "");
  const [version, setVersion] = useState(card?.spec.version ?? "");
  const [tags, setTags] = useState((card?.spec.tags ?? []).join(", "));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Editing an inline or git-source card: the CRD allows exactly one source
  // kind and this form authors image-ref only, so saving converts the card.
  const converts = isEdit && !card.spec.image && Boolean(card.spec.inline || card.spec.source);

  const nameError = isEdit ? undefined : nameInvalidReason(name);
  const imageMissing = !image.trim();
  const canSave = !nameError && !imageMissing && !submitting;

  const submit = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Exactly one source field (image), plus only the non-empty optionals.
      // The CRD treats tags as a set, so the comma list is deduped.
      const parsedTags = [
        ...new Set(
          tags
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
        ),
      ];
      const spec: SkillCardSpec = { image: image.trim(), type };
      if (displayName.trim()) spec.displayName = displayName.trim();
      if (description.trim()) spec.description = description.trim();
      if (version.trim()) spec.version = version.trim();
      if (parsedTags.length > 0) spec.tags = parsedTags;
      const targetName = isEdit ? (card.metadata.name ?? "") : name.trim();
      const saved = isEdit
        ? await api.updateSkillCard(targetName, spec)
        : await api.createSkillCard(targetName, spec);
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
      aria-labelledby="skillcard-modal-title"
    >
      <ModalHeader
        title={isEdit ? "Edit skill card" : "Create skill card"}
        labelId="skillcard-modal-title"
        description={
          isEdit
            ? "Updates the SkillCard spec; the controller re-resolves the image."
            : "Creates a SkillCard the controller resolves to an OCI image mounted at /opt/skills/<name>."
        }
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
        {converts && (
          <Alert
            variant="warning"
            isInline
            title="Saving converts this card to an image-ref card"
            style={{ marginBottom: "1rem" }}
          >
            This card currently uses {card.spec.inline ? "inline markdown" : "a git source"}. The
            CRD allows exactly one source kind and this form authors image refs only, so saving
            replaces the {card.spec.inline ? "inline content" : "git source"} with the image below.
          </Alert>
        )}
        <Form
          id="skillcard-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FormGroup label="Name" isRequired fieldId="skillcard-name">
            <TextInput
              id="skillcard-name"
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
                    : (nameError && name.trim() ? nameError : "Kubernetes object name; also the mount directory /opt/skills/<name>.")}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label="Display name" fieldId="skillcard-display-name">
            <TextInput
              id="skillcard-display-name"
              value={displayName}
              onChange={(_e, v) => setDisplayName(v)}
            />
          </FormGroup>

          <FormGroup label="Description" fieldId="skillcard-description">
            <TextArea
              id="skillcard-description"
              value={description}
              onChange={(_e, v) => setDescription(v)}
              rows={3}
              resizeOrientation="vertical"
            />
          </FormGroup>

          <FormGroup label="Type" fieldId="skillcard-type">
            <FormSelect
              id="skillcard-type"
              value={type}
              onChange={(_e, v) => setType(v as SkillCardType)}
            >
              <FormSelectOption value="skill" label="skill" />
              <FormSelectOption value="rule" label="rule" />
            </FormSelect>
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  "skill" loads on demand when the agent invokes it; "rule" is always loaded into
                  every LLM turn and counts against each turn's context budget.
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label="Image" isRequired fieldId="skillcard-image">
            <TextInput
              id="skillcard-image"
              isRequired
              value={image}
              onChange={(_e, v) => setImage(v)}
              placeholder="quay.io/konveyor/skills:analyze"
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  OCI image reference — image-ref cards are the only kind the controller resolves
                  to Ready today.
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label="Version" fieldId="skillcard-version">
            <TextInput
              id="skillcard-version"
              value={version}
              onChange={(_e, v) => setVersion(v)}
            />
          </FormGroup>

          <FormGroup label="Tags" fieldId="skillcard-tags">
            <TextInput
              id="skillcard-tags"
              value={tags}
              onChange={(_e, v) => setTags(v)}
              placeholder="java, migration, spring"
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  Comma-separated; duplicates are dropped (the CRD treats tags as a set).
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <Alert
            variant="info"
            isInline
            isPlain
            title="The CRD also supports inline markdown and git-source cards, but those reconcile to NotReady until Phase 3 — authoring here is image-ref only by design."
          />
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
