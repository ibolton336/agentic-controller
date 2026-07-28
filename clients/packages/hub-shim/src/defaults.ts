/**
 * The default managed resource set POST /api/defaults seeds — the API-first
 * replacement for demo-up.sh's kubectl seeding.
 *
 * Mirrors the upstream harness testbed (hack/harness-test on PR #53): one
 * LLMProvider named as a goose provider id, the four migration skill cards,
 * three stage Agents on agent-java, and the java-ee-to-quarkus playbook.
 * On top of that, the PatternFly demo set: a patternfly-migration domain
 * card paired with the same stage cards on agent-nodejs, as a second
 * playbook — proof the skill model generalizes beyond Java with zero code.
 *
 * Everything is labeled konveyor.io/managed=true (the upstream seeds are
 * not — filed as #53 feedback item 3), so it all shows up in Konveyor UIs.
 *
 * Seeding is create-only: a name that already exists is reported "exists"
 * and left untouched, so local edits survive a re-seed.
 */
import {
  IMAGE_CATALOG_CONFIGMAP,
  IMAGE_CATALOG_KEY,
  MANAGED_LABEL,
  type AgentImage,
} from "../../agentic-client/src/contract/index.js";
import { API_VERSION, PLURALS } from "../../agentrun-client/src/types.js";

/**
 * The upstream agent-image hierarchy (images/README.md on PR #53). Serves
 * as the built-in catalog when the ConfigMap is absent, and as the content
 * seeded INTO that ConfigMap by loadDefaults. The :dev tag matches what the
 * image build tooling stamps today; CI-published tags land post-#53.
 */
export const DEFAULT_IMAGE_CATALOG: AgentImage[] = [
  {
    image: "quay.io/konveyor/agent-base:dev",
    displayName: "Agent base",
    notes: "UBI 10 + goose CLI + git + Python 3 + graphify + migration-harness binary",
  },
  {
    image: "quay.io/konveyor/agent-java:dev",
    displayName: "Java agent",
    language: "java",
    base: "quay.io/konveyor/agent-base:dev",
    notes: "adds JDK 21 and Maven",
  },
  {
    image: "quay.io/konveyor/agent-go:dev",
    displayName: "Go agent",
    language: "go",
    base: "quay.io/konveyor/agent-base:dev",
    notes: "adds the Go toolchain",
  },
  {
    image: "quay.io/konveyor/agent-csharp:dev",
    displayName: "C# agent",
    language: "csharp",
    base: "quay.io/konveyor/agent-base:dev",
    notes: "adds the .NET SDK",
  },
  {
    image: "quay.io/konveyor/agent-nodejs:dev",
    displayName: "Node.js agent",
    language: "nodejs",
    base: "quay.io/konveyor/agent-base:dev",
    notes: "adds Node.js and npm",
  },
];

const MANAGED = { [MANAGED_LABEL]: "true" };

/** The catalog ConfigMap body loadDefaults creates (core/v1, not a CR). */
export function imageCatalogConfigMap(namespace: string): object {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: IMAGE_CATALOG_CONFIGMAP, namespace, labels: MANAGED },
    data: { [IMAGE_CATALOG_KEY]: JSON.stringify(DEFAULT_IMAGE_CATALOG, null, 2) },
  };
}

export interface DefaultResource {
  plural: string;
  kind: string;
  name: string;
  body: Record<string, unknown>;
}

function resource(
  plural: string,
  kind: string,
  name: string,
  spec: Record<string, unknown>,
): DefaultResource {
  return {
    plural,
    kind,
    name,
    body: { apiVersion: API_VERSION, kind, metadata: { name, labels: MANAGED }, spec },
  };
}

const skillCard = (name: string, displayName: string, description: string, tags: string[]) =>
  resource(PLURALS.SkillCard, "SkillCard", name, {
    image: `quay.io/konveyor/skills:${name}`,
    displayName,
    version: "1.0.0",
    description,
    type: "skill",
    tags,
  });

const stageAgent = (
  name: string,
  image: string,
  cards: string[],
  params: { name: string; type: string; default: string }[],
) =>
  resource(PLURALS.Agent, "Agent", name, {
    image,
    providers: [{ ref: SEED_PROVIDER }],
    skillCards: cards.map((ref) => ({ ref })),
    params,
  });

/**
 * Provider name maps VERBATIM to a goose provider id (lowercased, "-" ->
 * "_") — gcp-vertex-ai -> gcp_vertex_ai. Its credential Secret
 * (vertex-credentials) is not seeded: credentials never ride this path.
 */
const SEED_PROVIDER = "gcp-vertex-ai";

const MAX_TURNS = { name: "max_turns", type: "number", default: "200" };

const JAVA_IMAGE = "quay.io/konveyor/agent-java:dev";
const NODEJS_IMAGE = "quay.io/konveyor/agent-nodejs:dev";

/**
 * The full seed set, in create order (providers before the agents that
 * reference them; agents before playbooks). NOTE the deliberate name split
 * upstream chose: the PLAYBOOK is "java-ee-to-quarkus", the SKILLCARD is
 * "javaee-to-quarkus".
 */
export function defaultResources(): DefaultResource[] {
  return [
    resource(PLURALS.LLMProvider, "LLMProvider", SEED_PROVIDER, {
      endpoint: "global-aiplatform.googleapis.com",
      credentialRef: { secretName: "vertex-credentials" },
      models: [{ name: "claude-sonnet-4-5", contextWindow: 200000, tier: "premium" }],
    }),

    // Stage skills — language-agnostic: plan reads any project, execute
    // works PLAN.md, verify runs whatever build command PLAN.md names.
    skillCard("plan", "Plan Stage", "Reads a project and produces PLAN.md with migration steps.", [
      "migration",
      "planning",
    ]),
    skillCard(
      "execute",
      "Execute Stage",
      "Reads PLAN.md and executes each migration step sequentially.",
      ["migration", "execution"],
    ),
    skillCard(
      "verify",
      "Verify Stage",
      "Runs the build command, fixes errors, and iterates until the build passes.",
      ["migration", "verification"],
    ),

    // Domain skills — one per migration, paired with the stage skills.
    skillCard(
      "javaee-to-quarkus",
      "Java EE to Quarkus Migration",
      "Migrates Java EE 7/8 applications (WebLogic, JBoss, WildFly) to Quarkus 3. " +
        "Covers EJB-to-CDI, JMS/MDB-to-SmallRye, WAR-to-JAR, persistence.xml replacement, " +
        "JNDI removal, and server lifecycle replacement.",
      ["java", "javaee", "quarkus", "migration"],
    ),
    skillCard(
      "patternfly-migration",
      "PatternFly 5 to 6 Migration",
      "Migrates React applications from PatternFly 5 to PatternFly 6: design tokens, " +
        "Text-to-Content, removed components, pf-v6 class renames, and codemod-driven " +
        "API updates.",
      ["patternfly", "react", "nodejs", "migration"],
    ),

    stageAgent("migration-plan-agent", JAVA_IMAGE, ["plan", "javaee-to-quarkus"], [MAX_TURNS]),
    stageAgent("migration-execute-agent", JAVA_IMAGE, ["execute", "javaee-to-quarkus"], [MAX_TURNS]),
    stageAgent(
      "migration-verify-agent",
      JAVA_IMAGE,
      ["verify", "javaee-to-quarkus"],
      [MAX_TURNS, { name: "max_fix_iterations", type: "number", default: "3" }],
    ),

    stageAgent("patternfly-plan-agent", NODEJS_IMAGE, ["plan", "patternfly-migration"], [MAX_TURNS]),
    stageAgent(
      "patternfly-execute-agent",
      NODEJS_IMAGE,
      ["execute", "patternfly-migration"],
      [MAX_TURNS],
    ),
    stageAgent(
      "patternfly-verify-agent",
      NODEJS_IMAGE,
      ["verify", "patternfly-migration"],
      [MAX_TURNS, { name: "max_fix_iterations", type: "number", default: "3" }],
    ),

    resource(PLURALS.AgentPlaybook, "AgentPlaybook", "java-ee-to-quarkus", {
      guide: "Migrate a Java EE application to Quarkus 3",
      stages: [
        {
          name: "plan",
          agentRef: "migration-plan-agent",
          instructions:
            "Analyze the project structure using graphify and produce PLAN.md with migration steps",
        },
        {
          name: "execute",
          agentRef: "migration-execute-agent",
          instructions:
            "Execute each step in PLAN.md to migrate the code from Java EE to Quarkus",
        },
        {
          name: "verify",
          agentRef: "migration-verify-agent",
          instructions: "Run mvn clean compile, fix any compilation errors, then run tests",
        },
      ],
    }),

    resource(PLURALS.AgentPlaybook, "AgentPlaybook", "patternfly-migration", {
      guide: "Migrate a React application from PatternFly 5 to PatternFly 6",
      stages: [
        {
          name: "plan",
          agentRef: "patternfly-plan-agent",
          instructions:
            "Analyze the project structure and produce PLAN.md with PatternFly 6 migration steps",
        },
        {
          name: "execute",
          agentRef: "patternfly-execute-agent",
          instructions:
            "Execute each step in PLAN.md to migrate the UI from PatternFly 5 to PatternFly 6",
        },
        {
          name: "verify",
          agentRef: "patternfly-verify-agent",
          instructions:
            "Run npm install and npm run build, fix any build errors, then run tests if present",
        },
      ],
    }),
  ];
}
