# 8. Rename AgentPlaybook to AgentWorkload

Date: 2026-07-30

## Status

Accepted

## Context

The term "playbook" collides with Ansible playbooks, a heavily loaded term
in the Red Hat ecosystem, and caused recurring confusion about whether these
CRs were Ansible artifacts. Product decision 2026-07-30: rename the API.

## Decision

Kinds become AgentWorkload and AgentWorkloadRun (plurals agentworkloads,
agentworkloadruns). The spec field playbookRef becomes workloadRef, and the
sandbox env var KONVEYOR_PLAYBOOK_INSTRUCTIONS becomes
KONVEYOR_WORKLOAD_INSTRUCTIONS. Routes and UI naming follow the same rename.

## Consequences

Existing clusters must replace the CRDs — there is no conversion webhook, and
the API is v1alpha1, so a breaking rename is acceptable. This supersedes the
naming used in ADR-0001 but does not alter that record.
