import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Flex,
  FlexItem,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  TextArea,
  TextInput,
} from "@patternfly/react-core";
import {
  PARAM_NAME_PATTERN,
  RESOURCE_NAME_MAX,
  RESOURCE_NAME_PATTERN,
} from "@konveyor/agentic-client/contract";
import type {
  AgentParam,
  AgentParamType,
  AgentResource,
  AgentResourceSpec,
  LLMProvider,
  SkillCard,
  SkillCollection,
} from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage, truncate } from "../format";
import { ReadyLabel, paramValueInvalidReason, useImageCatalog, useProviders } from "./sources";

const CUSTOM_IMAGE = "__custom__";

interface AgentDesignerModalProps {
  api: ShimClient;
  /** Undefined = create; set = edit (name locked, spec replaced on save). */
  agent?: AgentResource;
  onClose: () => void;
  onSaved: (name: string) => void;
}

/** "1st", "2nd", "3rd", "4th" … */
function ordinal(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n}st`;
  if (mod10 === 2 && mod100 !== 12) return `${n}nd`;
  if (mod10 === 3 && mod100 !== 13) return `${n}rd`;
  return `${n}th`;
}

/** Muted "N models, primary: <name>" summary for a provider checkbox label. */
function providerModelsSummary(p: LLMProvider): string {
  const models = p.spec.models ?? [];
  const primary = models.find((m) => m.tier === "primary");
  const count = `${models.length} model${models.length === 1 ? "" : "s"}`;
  return primary ? `${count}, primary: ${primary.name}` : count;
}

interface ParamRow {
  key: number;
  name: string;
  type: AgentParamType;
  description: string;
  default: string;
  required: boolean;
}

function rowsFrom(params: AgentParam[] | undefined): ParamRow[] {
  return (params ?? []).map((p, i) => ({
    key: i,
    name: p.name,
    type: p.type ?? "string",
    description: p.description ?? "",
    default: p.default ?? "",
    required: p.required ?? false,
  }));
}

/** Why a param row cannot be saved, or undefined when it can. */
function paramRowInvalidReason(row: ParamRow, rows: ParamRow[]): string | undefined {
  if (!row.name.trim()) return "Name is required.";
  if (!PARAM_NAME_PATTERN.test(row.name)) {
    return "Name must match ^[a-zA-Z_][a-zA-Z0-9_]*$ (it becomes the KONVEYOR_PARAM_<NAME> env var).";
  }
  if (rows.some((r) => r !== row && r.name === row.name)) return "Duplicate parameter name.";
  if (row.type === "number" && row.default.trim()) {
    const bad = paramValueInvalidReason({ name: row.name, type: "number" }, row.default);
    if (bad) return `Default ${bad}.`;
  }
  return undefined;
}

export function AgentDesignerModal({ api, agent, onClose, onSaved }: AgentDesignerModalProps) {
  const isEdit = agent !== undefined;

  const [name, setName] = useState(agent?.metadata.name ?? "");
  const [prompt, setPrompt] = useState(agent?.spec.prompt ?? "");

  // Image: a catalog FormSelect (with a custom escape hatch) when the catalog
  // is non-empty, a plain TextInput otherwise. On edit start on the custom
  // path with the value filled in; when the catalog arrives and knows the
  // image, snap to that entry (once — never fight the user afterwards).
  const catalog = useImageCatalog(api);
  const [imageSelect, setImageSelect] = useState<string>(isEdit ? CUSTOM_IMAGE : "");
  const [customImage, setCustomImage] = useState(agent?.spec.image ?? "");
  const imageInitDone = useRef(false);
  useEffect(() => {
    if (!agent || imageInitDone.current || catalog.length === 0) return;
    imageInitDone.current = true;
    if (catalog.some((e) => e.image === agent.spec.image)) {
      setImageSelect(agent.spec.image);
    }
  }, [catalog, agent]);
  const effectiveImage =
    catalog.length > 0 && imageSelect !== CUSTOM_IMAGE ? imageSelect : customImage;

  // Providers: selection ORDER matters (the first ref drives the launcher's
  // default model policy), so state is an ordered list, not a set.
  const { providers, error: providersError } = useProviders(api);
  const [providerRefs, setProviderRefs] = useState<string[]>(
    () => agent?.spec.providers?.map((p) => p.ref) ?? [],
  );
  const toggleProvider = (ref: string, checked: boolean) => {
    setProviderRefs((prev) =>
      checked ? [...prev.filter((r) => r !== ref), ref] : prev.filter((r) => r !== ref),
    );
  };
  // Refs the agent declares but listProviders didn't return still need a row,
  // so they stay visible and un-checkable.
  const providerRows: { name: string; provider?: LLMProvider }[] = [
    ...providers.map((p) => ({ name: p.metadata.name ?? "", provider: p })),
    ...providerRefs
      .filter((ref) => !providers.some((p) => p.metadata.name === ref))
      .map((ref) => ({ name: ref })),
  ];

  // Skills: both groups optional individually, loudly warned when both empty.
  const [cards, setCards] = useState<SkillCard[] | null>(null);
  const [collections, setCollections] = useState<SkillCollection[] | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [cardRefs, setCardRefs] = useState<string[]>(
    () => agent?.spec.skillCards?.map((s) => s.ref) ?? [],
  );
  const [collectionRefs, setCollectionRefs] = useState<string[]>(
    () => agent?.spec.skillCollections?.map((s) => s.ref) ?? [],
  );
  useEffect(() => {
    let disposed = false;
    Promise.all([api.listSkillCards(), api.listSkillCollections()])
      .then(([cardList, collectionList]) => {
        if (disposed) return;
        setCards(cardList);
        setCollections(collectionList);
      })
      .catch((err) => {
        if (!disposed) setSkillsError(errorMessage(err));
      });
    return () => {
      disposed = true;
    };
  }, [api]);
  const toggleRef = (
    set: (fn: (prev: string[]) => string[]) => void,
    ref: string,
    checked: boolean,
  ) => {
    set((prev) => (checked ? [...prev.filter((r) => r !== ref), ref] : prev.filter((r) => r !== ref)));
  };

  // Params editor rows.
  const [paramRows, setParamRows] = useState<ParamRow[]>(() => rowsFrom(agent?.spec.params));
  const nextKey = useRef(paramRows.length);
  const updateRow = (key: number, patch: Partial<ParamRow>) => {
    setParamRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...patch };
        // CRD CEL rule: a parameter with a default value cannot be required.
        if (next.default.trim()) next.required = false;
        return next;
      }),
    );
  };

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const nameInvalidReason = !isEdit
    ? !trimmedName
      ? "Name is required."
      : trimmedName.length > RESOURCE_NAME_MAX
        ? `Name must be at most ${RESOURCE_NAME_MAX} characters.`
        : !RESOURCE_NAME_PATTERN.test(trimmedName)
          ? "Name must be a DNS-1123 name: lowercase alphanumerics, '-' and '.', starting and ending alphanumeric."
          : undefined
    : undefined;
  const imageMissing = !effectiveImage.trim();
  const noProviders = providerRefs.length === 0;
  const paramsInvalid = paramRows.some((r) => paramRowInvalidReason(r, paramRows) !== undefined);
  const noSkills = cardRefs.length === 0 && collectionRefs.length === 0;

  const canSave =
    !submitting && !nameInvalidReason && !imageMissing && !noProviders && !paramsInvalid;

  const submit = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const spec: AgentResourceSpec = {
        image: effectiveImage.trim(),
        providers: providerRefs.map((ref) => ({ ref })),
      };
      const trimmedPrompt = prompt.trim();
      if (trimmedPrompt) spec.prompt = trimmedPrompt;
      if (cardRefs.length > 0) spec.skillCards = cardRefs.map((ref) => ({ ref }));
      if (collectionRefs.length > 0) {
        spec.skillCollections = collectionRefs.map((ref) => ({ ref }));
      }
      if (paramRows.length > 0) {
        spec.params = paramRows.map((r) => {
          const p: AgentParam = { name: r.name, type: r.type };
          if (r.description.trim()) p.description = r.description.trim();
          if (r.default.trim()) p.default = r.default.trim();
          if (r.required) p.required = true;
          return p;
        });
      }
      const saved = isEdit
        ? await api.updateAgent(agent.metadata.name ?? trimmedName, spec)
        : await api.createAgent(trimmedName, spec);
      onSaved(saved.metadata.name ?? trimmedName);
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
      aria-labelledby="agent-designer-title"
    >
      <ModalHeader
        title={isEdit ? "Edit agent" : "Create agent"}
        labelId="agent-designer-title"
        description={
          isEdit
            ? `Replaces the spec of Agent ${agent.metadata.name ?? ""}; existing runs keep the spec they started with.`
            : "Creates an Agent template — running it later creates AgentRuns with concrete values."
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
        <Form
          id="agent-designer-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {!isEdit && (
            <FormGroup label="Name" isRequired fieldId="agent-name">
              <TextInput
                id="agent-name"
                isRequired
                value={name}
                onChange={(_e, v) => setName(v)}
                validated={name && nameInvalidReason ? "error" : "default"}
              />
              {name && nameInvalidReason && (
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem variant="error">{nameInvalidReason}</HelperTextItem>
                  </HelperText>
                </FormHelperText>
              )}
            </FormGroup>
          )}

          <FormGroup label="Image" isRequired fieldId="agent-image">
            {catalog.length > 0 ? (
              <>
                <FormSelect
                  id="agent-image"
                  value={imageSelect}
                  onChange={(_e, v) => setImageSelect(v)}
                >
                  <FormSelectOption value="" label="Select an image…" isPlaceholder isDisabled />
                  {catalog.map((e) => (
                    <FormSelectOption
                      key={e.image}
                      value={e.image}
                      label={`${e.displayName} — ${e.image}`}
                    />
                  ))}
                  <FormSelectOption value={CUSTOM_IMAGE} label="Custom image…" />
                </FormSelect>
                {imageSelect === CUSTOM_IMAGE && (
                  <TextInput
                    id="agent-image-custom"
                    aria-label="Custom image reference"
                    style={{ marginTop: "0.5rem" }}
                    value={customImage}
                    onChange={(_e, v) => setCustomImage(v)}
                    placeholder="registry.example.com/my-agent:tag"
                  />
                )}
              </>
            ) : (
              <TextInput
                id="agent-image"
                isRequired
                value={customImage}
                onChange={(_e, v) => setCustomImage(v)}
                placeholder="registry.example.com/my-agent:tag"
              />
            )}
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant={imageMissing ? "error" : "default"}>
                  {imageMissing
                    ? "An image is required — it carries the agent runtime (ACP server on :4000/acp)."
                    : "Container image carrying the agent runtime (ACP server on :4000/acp)."}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label="Prompt" fieldId="agent-prompt">
            <TextArea
              id="agent-prompt"
              value={prompt}
              onChange={(_e, v) => setPrompt(v)}
              rows={4}
              resizeOrientation="vertical"
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  standing instructions, composed with each run's instructions
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label="Providers" isRequired fieldId="agent-providers" role="group">
            {providersError && (
              <Alert
                variant="warning"
                isInline
                title="Failed to load LLM providers"
                style={{ marginBottom: "0.5rem" }}
              >
                {providersError}
              </Alert>
            )}
            {providerRows.map(({ name: providerName, provider }) => {
              const position = providerRefs.indexOf(providerName);
              return (
                <Checkbox
                  key={providerName}
                  id={`agent-provider-${providerName}`}
                  isChecked={position >= 0}
                  onChange={(_e, checked) => toggleProvider(providerName, checked)}
                  label={
                    <span>
                      {providerName}
                      {provider && (
                        <span style={{ opacity: 0.7 }}> — {providerModelsSummary(provider)}</span>
                      )}
                      {position >= 0 && (
                        <>
                          {" "}
                          <Label isCompact color={position === 0 ? "blue" : "grey"}>
                            {ordinal(position + 1)}
                          </Label>
                        </>
                      )}
                    </span>
                  }
                />
              );
            })}
            <FormHelperText>
              <HelperText>
                {noProviders ? (
                  <HelperTextItem variant="error">
                    At least one provider is required (CRD minimum). Selection order matters: the
                    1st provider drives the default model policy at run creation.
                  </HelperTextItem>
                ) : (
                  <HelperTextItem>
                    Selection order matters: the 1st provider drives the default model policy at
                    run creation.
                  </HelperTextItem>
                )}
                <HelperTextItem>
                  The provider CR name maps verbatim to a goose provider id (lowercased,
                  "-" becomes "_").
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          {skillsError && (
            <Alert variant="warning" isInline title="Failed to load skills">
              {skillsError}
            </Alert>
          )}

          {noSkills && (
            <Alert variant="danger" isInline title="No skills selected">
              No skills selected — the migration-harness fails fatally with zero mounted skills.
              Runs of this agent are doomed unless it is a fixture (mock harness).
            </Alert>
          )}

          <FormGroup label="Skill cards" fieldId="agent-skill-cards" role="group">
            {cards !== null && cards.length === 0 ? (
              <FormHelperText>
                <HelperText>
                  <HelperTextItem>No skill cards exist yet.</HelperTextItem>
                </HelperText>
              </FormHelperText>
            ) : (
              (cards ?? []).map((c) => {
                const cardName = c.metadata.name ?? "";
                return (
                  <Checkbox
                    key={cardName}
                    id={`agent-skill-card-${cardName}`}
                    isChecked={cardRefs.includes(cardName)}
                    onChange={(_e, checked) => toggleRef(setCardRefs, cardName, checked)}
                    label={
                      <span>
                        {cardName}
                        {c.spec.displayName && (
                          <span style={{ opacity: 0.7 }}> — {c.spec.displayName}</span>
                        )}{" "}
                        <ReadyLabel resource={c} />
                        {c.status?.resolvedImage && (
                          <>
                            {" "}
                            <code>{truncate(c.status.resolvedImage, 50)}</code>
                          </>
                        )}
                      </span>
                    }
                  />
                );
              })
            )}
          </FormGroup>

          <FormGroup label="Skill collections" fieldId="agent-skill-collections" role="group">
            {collections !== null && collections.length === 0 ? (
              <FormHelperText>
                <HelperText>
                  <HelperTextItem>No skill collections exist yet.</HelperTextItem>
                </HelperText>
              </FormHelperText>
            ) : (
              (collections ?? []).map((c) => {
                const collectionName = c.metadata.name ?? "";
                return (
                  <Checkbox
                    key={collectionName}
                    id={`agent-skill-collection-${collectionName}`}
                    isChecked={collectionRefs.includes(collectionName)}
                    onChange={(_e, checked) =>
                      toggleRef(setCollectionRefs, collectionName, checked)
                    }
                    label={
                      <span>
                        {collectionName} <ReadyLabel resource={c} />
                      </span>
                    }
                  />
                );
              })
            )}
          </FormGroup>

          <FormGroup label="Parameters" fieldId="agent-params" role="group">
            {paramRows.map((row) => {
              const invalidReason = paramRowInvalidReason(row, paramRows);
              const hasDefault = row.default.trim() !== "";
              return (
                <div key={row.key} style={{ marginBottom: "0.75rem" }}>
                  <Flex
                    spaceItems={{ default: "spaceItemsSm" }}
                    alignItems={{ default: "alignItemsCenter" }}
                  >
                    <FlexItem grow={{ default: "grow" }}>
                      <TextInput
                        id={`agent-param-name-${row.key}`}
                        aria-label="Parameter name"
                        placeholder="name"
                        value={row.name}
                        validated={invalidReason ? "error" : "default"}
                        onChange={(_e, v) => updateRow(row.key, { name: v })}
                      />
                    </FlexItem>
                    <FlexItem>
                      <FormSelect
                        id={`agent-param-type-${row.key}`}
                        aria-label="Parameter type"
                        value={row.type}
                        onChange={(_e, v) => updateRow(row.key, { type: v as AgentParamType })}
                      >
                        <FormSelectOption value="string" label="string" />
                        <FormSelectOption value="number" label="number" />
                        <FormSelectOption value="boolean" label="boolean" />
                      </FormSelect>
                    </FlexItem>
                    <FlexItem grow={{ default: "grow" }}>
                      <TextInput
                        id={`agent-param-description-${row.key}`}
                        aria-label="Parameter description"
                        placeholder="description"
                        value={row.description}
                        onChange={(_e, v) => updateRow(row.key, { description: v })}
                      />
                    </FlexItem>
                    <FlexItem grow={{ default: "grow" }}>
                      <TextInput
                        id={`agent-param-default-${row.key}`}
                        aria-label="Parameter default"
                        placeholder="default"
                        type={row.type === "number" ? "number" : "text"}
                        value={row.default}
                        isDisabled={row.required}
                        validated={
                          row.type === "number" &&
                          row.default.trim() &&
                          paramValueInvalidReason({ name: row.name, type: "number" }, row.default)
                            ? "error"
                            : "default"
                        }
                        onChange={(_e, v) => updateRow(row.key, { default: v })}
                      />
                    </FlexItem>
                    <FlexItem>
                      <Checkbox
                        id={`agent-param-required-${row.key}`}
                        label="Required"
                        isChecked={row.required}
                        isDisabled={hasDefault}
                        onChange={(_e, checked) => updateRow(row.key, { required: checked })}
                      />
                    </FlexItem>
                    <FlexItem>
                      <Button
                        variant="link"
                        isInline
                        isDanger
                        onClick={() =>
                          setParamRows((prev) => prev.filter((r) => r.key !== row.key))
                        }
                      >
                        Remove
                      </Button>
                    </FlexItem>
                  </Flex>
                  {(invalidReason || hasDefault) && (
                    <FormHelperText>
                      <HelperText>
                        {invalidReason && (
                          <HelperTextItem variant="error">{invalidReason}</HelperTextItem>
                        )}
                        {hasDefault && (
                          <HelperTextItem>
                            CRD: a parameter with a default cannot be required
                          </HelperTextItem>
                        )}
                      </HelperText>
                    </FormHelperText>
                  )}
                </div>
              );
            })}
            <Button
              variant="link"
              isInline
              onClick={() =>
                setParamRows((prev) => [
                  ...prev,
                  {
                    key: nextKey.current++,
                    name: "",
                    type: "string",
                    description: "",
                    default: "",
                    required: false,
                  },
                ])
              }
            >
              Add parameter
            </Button>
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  Runs supply parameter values, injected as KONVEYOR_PARAM_&lt;NAME&gt; env vars.
                </HelperTextItem>
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
