/**
 * "Load defaults" — POST /api/defaults through the shim: seeds the managed
 * default set (provider, stage skill cards, domain cards, stage agents on
 * agent-java/agent-nodejs, the java-ee-to-quarkus and patternfly-migration
 * playbooks, and the agent-image catalog ConfigMap). The API-first
 * replacement for demo-up.sh's kubectl seeding. Create-only and re-runnable:
 * existing resources are reported, never touched.
 */
import { useState } from "react";
import { Alert, Button } from "@patternfly/react-core";
import type { SeedResult } from "@konveyor/agentic-client/contract";
import type { ShimClient } from "@konveyor/agentic-client/transport-shim";
import { errorMessage } from "../format";

interface LoadDefaultsButtonProps {
  api: ShimClient;
  /** Called after a successful seed so the page can refresh its lists. */
  onSeeded?: () => void;
}

export function LoadDefaultsButton({ api, onSeeded }: LoadDefaultsButtonProps) {
  const [seeding, setSeeding] = useState(false);
  const [results, setResults] = useState<SeedResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seed = async () => {
    setSeeding(true);
    setError(null);
    try {
      setResults(await api.loadDefaults());
      onSeeded?.();
    } catch (err) {
      setResults(null);
      setError(errorMessage(err));
    } finally {
      setSeeding(false);
    }
  };

  const created = results?.filter((r) => r.status === "created") ?? [];
  const existing = (results?.length ?? 0) - created.length;

  return (
    <>
      <Button variant="secondary" isLoading={seeding} isDisabled={seeding} onClick={() => void seed()}>
        Load defaults
      </Button>
      {error && (
        <Alert variant="danger" isInline isPlain title="Load defaults failed">
          {error}
        </Alert>
      )}
      {results && (
        <Alert
          variant={created.length > 0 ? "success" : "info"}
          isInline
          isPlain
          title={
            created.length > 0
              ? `Seeded ${created.length} resource${created.length === 1 ? "" : "s"}` +
                (existing > 0 ? ` (${existing} already existed)` : "")
              : "All default resources already exist"
          }
        >
          {created.length > 0 &&
            created.map((r) => `${r.kind}/${r.name}`).join(", ")}
        </Alert>
      )}
    </>
  );
}
