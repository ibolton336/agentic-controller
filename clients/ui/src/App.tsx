import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Masthead,
  MastheadBrand,
  MastheadContent,
  MastheadMain,
  Page,
  PageSection,
  Title,
  ToggleGroup,
  ToggleGroupItem,
} from "@patternfly/react-core";
import { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage } from "./format";
import { RunsPage } from "./components/RunsPage";
import { RunDetailPage } from "./components/RunDetailPage";
import { PlaybookRunsPage } from "./components/PlaybookRunsPage";
import { PlaybookRunDetailPage } from "./components/PlaybookRunDetailPage";
import { AgentsPage } from "./components/AgentsPage";
import { SkillsPage } from "./components/SkillsPage";
import { PlaybooksPage } from "./components/PlaybooksPage";

// Dev default: the local shim. Production (static build behind nginx):
// same-origin — nginx proxies /api (HTTP + WebSocket) to the gateway.
const SHIM_URL =
  import.meta.env.VITE_SHIM_URL ??
  (import.meta.env.DEV ? "http://127.0.0.1:7080" : window.location.origin);

type View =
  | { kind: "list" }
  | { kind: "detail"; runName: string; fromPlaybookRun?: string }
  | { kind: "playbooks" }
  | { kind: "playbookDetail"; name: string }
  | { kind: "agents" }
  | { kind: "skills" }
  | { kind: "playbookLibrary" };

// ---------------------------------------------------- hash deep-link routing
//
// The hash is the single shareable source of truth (#/runs/<name>, #/agents…).
// In-memory-only view context (fromPlaybookRun back-navigation) deliberately
// does NOT serialize: a deep-linked run detail backs out to the runs list.

function viewToHash(view: View): string {
  switch (view.kind) {
    case "list":
      return "#/runs";
    case "detail":
      return `#/runs/${encodeURIComponent(view.runName)}`;
    case "playbooks":
      return "#/playbook-runs";
    case "playbookDetail":
      return `#/playbook-runs/${encodeURIComponent(view.name)}`;
    case "agents":
      return "#/agents";
    case "skills":
      return "#/skills";
    case "playbookLibrary":
      return "#/playbooks";
  }
}

function hashToView(hash: string): View {
  // Hand-edited hashes can carry malformed percent-encoding (#/runs/100%);
  // an unguarded decodeURIComponent would throw during the initial useState
  // initializer — white screen. Fall back to the raw segment.
  const safeDecode = (segment: string): string => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  };
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(safeDecode);
  switch (parts[0]) {
    case "runs":
      return parts[1] ? { kind: "detail", runName: parts[1] } : { kind: "list" };
    case "playbook-runs":
      return parts[1] ? { kind: "playbookDetail", name: parts[1] } : { kind: "playbooks" };
    case "agents":
      return { kind: "agents" };
    case "skills":
      return { kind: "skills" };
    case "playbooks":
      return { kind: "playbookLibrary" };
    default:
      return { kind: "list" };
  }
}

export function App() {
  const [view, setViewState] = useState<View>(() => hashToView(window.location.hash));

  // navigate() owns hash writes; the hashchange/popstate listener covers
  // back/forward and hand-edited URLs. The serialize-compare guard breaks
  // the loop the two would otherwise feed (navigate -> hashchange -> setView
  // -> …) while preserving in-memory context (fromPlaybookRun) the hash
  // deliberately drops.
  const navigate = (next: View) => {
    setViewState(next);
    const hash = viewToHash(next);
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
  };

  useEffect(() => {
    const onHashChange = () => {
      setViewState((current) =>
        viewToHash(current) === (window.location.hash || "#/runs")
          ? current
          : hashToView(window.location.hash),
      );
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onHashChange);
    };
  }, []);

  // ShimClient validates the base URL eagerly — surface a bad VITE_SHIM_URL
  // as an alert instead of a white screen.
  const api = useMemo<{ client?: ShimClient; error?: string }>(() => {
    try {
      return { client: new ShimClient(SHIM_URL) };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }, []);

  const masthead = (
    <Masthead>
      <MastheadMain>
        <MastheadBrand>
          <Title headingLevel="h1" size="lg" style={{ whiteSpace: "nowrap" }}>
            Konveyor Agentic Runs{" "}
            <span style={{ fontWeight: 400, opacity: 0.7 }}>(prototype)</span>
          </Title>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <span className="masthead-shim">shim: {SHIM_URL}</span>
      </MastheadContent>
    </Masthead>
  );

  // Top-level sections: the two run consoles, then the management catalog
  // (Agents / Skills / Playbooks — Phase 1 management UX).
  const nav: { text: string; id: string; kind: View["kind"]; view: View }[] = [
    { text: "Agent runs", id: "nav-runs", kind: "list", view: { kind: "list" } },
    { text: "Playbook runs", id: "nav-playbook-runs", kind: "playbooks", view: { kind: "playbooks" } },
    { text: "Agents", id: "nav-agents", kind: "agents", view: { kind: "agents" } },
    { text: "Skills", id: "nav-skills", kind: "skills", view: { kind: "skills" } },
    { text: "Playbooks", id: "nav-playbooks", kind: "playbookLibrary", view: { kind: "playbookLibrary" } },
  ];
  const onList = nav.some((item) => item.kind === view.kind);

  return (
    <Page masthead={masthead}>
      {api.error || !api.client ? (
        <PageSection>
          <Alert variant="danger" isInline title="Invalid shim URL (VITE_SHIM_URL)">
            {api.error ?? "no client"}
          </Alert>
        </PageSection>
      ) : (
        <>
          {onList && (
            <PageSection style={{ paddingBottom: 0 }}>
              <ToggleGroup aria-label="Console section">
                {nav.map((item) => (
                  <ToggleGroupItem
                    key={item.id}
                    text={item.text}
                    buttonId={item.id}
                    isSelected={view.kind === item.kind}
                    onChange={() => navigate(item.view)}
                  />
                ))}
              </ToggleGroup>
            </PageSection>
          )}
          {view.kind === "list" ? (
            <RunsPage
              api={api.client}
              onOpenRun={(runName) => navigate({ kind: "detail", runName })}
              onOpenPlaybookRun={(name) => navigate({ kind: "playbookDetail", name })}
            />
          ) : view.kind === "playbooks" ? (
            <PlaybookRunsPage
              api={api.client}
              onOpenPlaybookRun={(name) => navigate({ kind: "playbookDetail", name })}
            />
          ) : view.kind === "agents" ? (
            <AgentsPage api={api.client} />
          ) : view.kind === "skills" ? (
            <SkillsPage api={api.client} />
          ) : view.kind === "playbookLibrary" ? (
            <PlaybooksPage api={api.client} />
          ) : view.kind === "playbookDetail" ? (
            <PlaybookRunDetailPage
              api={api.client}
              name={view.name}
              onBack={() => navigate({ kind: "playbooks" })}
              onDeleted={() => navigate({ kind: "playbooks" })}
              onRerun={(name) => navigate({ kind: "playbookDetail", name })}
              onOpenRun={(runName) =>
                navigate({ kind: "detail", runName, fromPlaybookRun: view.name })
              }
            />
          ) : (
            <RunDetailPage
              api={api.client}
              runName={view.runName}
              onBack={() =>
                navigate(
                  view.fromPlaybookRun
                    ? { kind: "playbookDetail", name: view.fromPlaybookRun }
                    : { kind: "list" },
                )
              }
              onDeleted={() =>
                navigate(
                  view.fromPlaybookRun
                    ? { kind: "playbookDetail", name: view.fromPlaybookRun }
                    : { kind: "list" },
                )
              }
              onRerun={(newRunName) => navigate({ kind: "detail", runName: newRunName })}
            />
          )}
        </>
      )}
    </Page>
  );
}
