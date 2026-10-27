---
adr: "0020"
title: "Git host awareness, run identity, and fork-based result delivery"
description: "Separates the repository a run clones from the repository it pushes to, names the three identities a run carries, and keeps git-host API operations (fork, pull request) out of the sandbox."
status: proposed
status_note: "Design input for MTA-8131. Nothing here is implemented; the current harness pushes a branch to the application's source repository."
date: "2026-10-27"
last_updated: null
authors: []
last_reviewed: "2026-10-27"
implementation_status: deferred
review_note: "Proposed contract only. The harness still clones and pushes the same remote, selects the push credential by application rather than by run, and reports no result location."
relates_to:
  - "ADR 0001 (Git-as-persistence; Two repos per application)"
  - "ADR 0006 (Hub addon pattern; scoped token at create time)"
  - "ADR 0007 (harness git lifecycle)"
  - "ADR 0011 / ADR 0018 (termination log and terminationData)"
  - "ADR 0013 (c) (credentials resolve at runtime, never at create time)"
  - "MTA-8131: Design Git hosting account linking, fork-based work, and result delivery for agentic migrations"
---

# ADR 0020: Git host awareness, run identity, and fork-based result delivery

## Context

A run today has exactly one way to deliver results: it clones the
application's source repository, checks out a caller-supplied
`TARGET_BRANCH`, and pushes that branch back to the **same** remote it
cloned from, both incrementally (the 30-second quiet-period watcher) and
on exit (`harness/cmd/migration-harness/main.go`, `harness/internal/git/git.go`).
There is no fork, no pull or merge request, and nothing reports where the
results landed. A developer learns the branch name from whatever created
the run.

The credential used for that push is selected **by application, not by
run**: the harness fetches the Hub identity with role `source` on the
application, falling back to the global default source identity
(`harness/internal/hub/client.go`). Whoever created the run, the push
carries the application's stored credential, usually a shared machine
token. Commit authorship is a separate, already-modelled knob
(`gitConfig` on Agent and AgentRun) that defaults to a bot identity.

ADR 0001 decided a different shape and it was never implemented:

> **Source repo** — clone from (read-only credentials sufficient)
> **Assets repo** — push results to (write credentials required)
> If no assets repo is configured, the harness pushes to the source repo
> on a `konveyor/<run-name>` branch.

Hub's application model already carries the pieces that decision needs:
`Application.Repository`, `Application.Assets` (a second `Repository`),
`Application.Identities`, `Application.Owner`, and `Application.Contributors`.
`Repository.Kind` distinguishes only git from subversion; nothing records
which git host (GitHub, GitLab, self-hosted) serves a repository. Hub's
existing `Platform` resource names a *deployment* target with its own
identity, so that word is taken.

The discussion recorded in MTA-8131 asks for three things:

1. know whether an application's repository is GitHub, GitLab, or other;
2. link a Konveyor user to their git-host account;
3. do agent work in a fork rather than directly on the source repository,
   and have automated runs act under an identity of their own (the
   `redhat-chai-bot` precedent) while interactive runs may act as the user.

Those are mostly Hub concerns. This ADR records what the platform side of
the contract must look like so that Hub, the harness, and the UI can be
designed against the same shape, and so that the controller's existing
boundaries survive it.

## Decision

### 1. The controller stays out of it

No git-host, fork, repository, branch, or identity-selection field is
added to any CRD. Design principle 1 (the controller is domain-agnostic)
and principle 3 (push credentials stay in the harness) are unchanged.
Everything below is carried through the channels that already exist: Hub
data the harness resolves at runtime (ADR 0006, ADR 0013 (c)), env the
creating host injects, and the opaque termination log the controller
copies into `status.terminationData` (ADR 0011, ADR 0018).

### 2. A run has a source repository and a work repository

The harness distinguishes two remotes, generalising ADR 0001's two-repo
decision:

| Remote | Purpose | Credential need |
| --- | --- | --- |
| **source** | cloned at start; the application's `repository` | read |
| **work** | receives `TARGET_BRANCH` pushes; the fork, the assets repository, or the source repository itself | write, to that one repository |

Resolution order for the work repository, decided by Hub and read by the
harness, not computed in the harness:

1. an explicit work repository for this run (a fork owned by the run's
   principal, see §3);
2. the application's `assets` repository, when configured;
3. the source repository (today's behaviour, and the permanent fallback
   for hosts where forking is unavailable or forbidden by policy).

The harness clones **source**, adds **work** as a second named remote,
strips credentials from both (`StripCredentials` today handles only
`origin`), and pushes `TARGET_BRANCH` to **work** only. The rule that
`TARGET_BRANCH` must differ from the source branch is kept when work and
source are the same repository and dropped otherwise; a fork's default
branch is a legitimate target.

Workflow runs resolve the work repository **once per AgentWorkflowRun**.
Every stage pushes to the same remote with the same credential, exactly
as stages share one target branch and one Hub token today. A fork that
must be created is created before stage one, never by a stage.

### 3. Three identities, kept separate

A run carries three identities. The discussion in MTA-8131 treats
"identity" as one thing; the code already has two, and the design should
name all three rather than collapse them:

| Identity | Decides | Lives today |
| --- | --- | --- |
| **Commit author** | whose name is on each commit | `gitConfig` on Agent / AgentRun; defaults to `migration-agent@konveyor.io` |
| **Push identity** | which credential pushes to the work repository | the application's `source` Hub identity, by application |
| **Host identity** | which account forks, opens a pull or merge request, and is shown as the PR author | does not exist |

"Commits as me, pushed by the bot" is already expressible and stays the
default for interactive runs. "Pushed as me" and "PR opened as me" become
possible when Hub resolves the push and host identities from the **run
principal**: the Hub user who created the run, or a bot identity for
automated runs. A bot is an ordinary Hub `Identity` (a GitHub App
installation or a machine user, as `redhat-chai-bot` is) and is linked to
a user the same way a human's account is. Which principal a run gets is
Hub's authorisation decision, taken when it mints the scoped token at
create time (ADR 0006); the harness never chooses.

The harness receives the push identity the way it receives the source
identity now: by asking Hub at runtime with its scoped token. It never
receives the host identity (see §4).

### 4. Git-host API operations happen in Hub, not in the sandbox

Forking a repository and opening a pull or merge request require a
host API token with scopes well beyond "push to one repository". That
token must not enter the sandbox: the sandbox already holds the push
credential on its filesystem (ADR 0001 notes the limits of that
isolation), and a prompt-injected agent with fork and PR scopes on a
user's account is a materially worse outcome than one with push rights
to a single fork branch.

Therefore:

- **Fork creation** is a Hub operation performed before the run's
  Sandbox exists, with the principal's host identity. The harness only
  ever sees the resulting work repository URL and a push credential for
  it.
- **Opening the pull or merge request** is a Hub operation after the run
  reaches a terminal state with a pushed result. Two triggers, both
  needed: on demand from the UI (the developer reviews the branch and
  clicks "open pull request", acting as themselves, which answers the
  "some actions as my identity" case) and automatic on completion for
  runs whose principal is a bot (there is nobody to click).
- The harness gains **no** host-specific code paths. Its only new
  behaviour is the second remote in §2.

Hub needs a small per-host adapter (GitHub, GitLab, generic=none) for
fork and pull-request calls. The host of a repository is Hub data: a
**git host** record (kind, API base URL, which identity kinds it
accepts), inferred from the repository URL for `github.com` and
`gitlab.com` and set explicitly for self-hosted instances, where the URL
alone does not reveal the API endpoint.

### 5. The harness reports where results landed

The termination log gains one optional object, within the existing
4096-byte ceiling:

```json
{
  "exitCode": 0,
  "outcome": "succeeded",
  "result": {
    "repository": "https://github.com/jdoe/coolstore",
    "branch": "konveyor/migration",
    "pushed": true
  }
}
```

`pushed` is the existing "no commits, push skipped" signal that the
notices already carry, made machine-readable. The controller copies it
verbatim as it copies everything else in `terminationData`; no CRD
change. Hub reads it to know which repository and branch to open a pull
request against, and the UI reads it to link the developer to the
branch. The pull-request URL itself is Hub state, not run state, since
Hub creates it after the run is over.

### 6. Terminology

To keep `CONTEXT.md` consistent when this is accepted, the following
terms are proposed and used throughout this ADR:

- **Git host** — the service hosting a repository (GitHub, GitLab, a
  self-hosted instance, or generic). Not *platform*, which Hub already
  uses for deployment targets.
- **Work repository** — the repository a run pushes to. May be a fork,
  the application's assets repository, or the source repository.
- **Run principal** — the Hub user or bot identity a run acts for. Hub
  resolves the push and host identities from it.
- **Result delivery** — how a run's pushed branch reaches a human:
  `branch` (today) or `pull-request` (a PR or MR opened by Hub).

## Consequences

- The harness change is small and host-agnostic: one more remote, a
  push target that may differ from the clone source, and a `result`
  object in the termination log. ADR 0007's lifecycle list gains "add
  work remote" and loses nothing.
- Credential blast radius shrinks. The source credential can become
  read-only once a work repository exists, and the push credential is
  scoped to one fork. Host API scopes never reach the pod.
- Hub takes on git-host adapters, fork lifecycle, user-to-host-account
  linking, and pull-request creation. That is where the user, the
  application, and the identity vault already live, so no new data
  crosses a boundary.
- Automated runs become "a bot principal with a linked host account",
  which is the same path as a human user. No second mechanism.
- The branch-on-source-repository path remains the default until Hub
  supplies a work repository, so nothing regresses for installations
  that never configure a git host.
- `StripCredentials` and the push path need to handle a second remote;
  the `TARGET_BRANCH` same-branch guard needs to become conditional on
  work and source being the same repository.

## Open questions for MTA-8131

1. **Fork policy.** Many organisations disable forking of private
   repositories into personal namespaces. The fallback in §2 covers it,
   but the UI must explain why a run landed on the source repository.
2. **GitLab merge requests require a fork relationship.** A work
   repository that is a bot-owned copy rather than a true fork cannot
   open an MR. Hub's fork step must create a real fork on GitLab.
3. **Token lifetime.** GitHub App installation tokens expire in an hour;
   a long run's final push needs a token minted close to exit, or a
   longer-lived push credential. The watcher's incremental pushes have
   the same exposure.
4. **Draft pull request early or final pull request late.** Incremental
   pushes make a draft PR at first push attractive for visibility, but
   it needs Hub to act mid-run, which it does not do today. Recommend
   PR-on-completion first.
5. **Stale forks and branches.** Nothing cleans up fork branches from
   abandoned runs. Decide whether Hub deletes them on run deletion.
6. **Pull-request body.** `.konveyor/handoff.md` is the natural body
   source. Decide whether Hub reads it from the pushed branch or the
   harness copies it into the termination log (the 4096-byte ceiling
   says the former).
7. **Where the pull-request URL is shown.** Hub state keyed by run, or a
   label or annotation Hub writes back onto the AgentRun (the pattern
   ADR 0013 (a) uses for `konveyor.io/application`). Either keeps the
   CRD schema untouched.
8. **Linking UX.** Whether a user links one account per git host, and
   how an administrator provisions the bot identities, is Hub and UI
   design outside this repository.

## Alternatives considered

### Fields on AgentRun for repository, branch, and delivery mode

Rejected. It moves domain vocabulary into the generic CRD, exactly the
objection ADR 0013 raised against a `source` enum, and the controller
would carry fields it never reads.

### The harness forks and opens the pull request itself

Rejected for the reason in §4: it puts a host API token with fork and
pull-request scopes on the sandbox filesystem next to the agent. It also
makes the harness host-specific, which ADR 0007's thin-runner decision
avoids. If Hub-side PR creation proves impossible for some host, the
fallback is a separate post-run Hub task, still outside the sandbox,
not the harness.

### Infer the git host from the repository URL in the harness

Rejected as a standalone answer. It works for `github.com` and
`gitlab.com` and fails for self-hosted instances, which are common in
the installations this product targets. Inference is fine as a default
Hub applies when creating the git host record.

### Materialise the push credential at create time via envFrom

Rejected by ADR 0013 (c) and unchanged here: credentials resolve at
runtime through the scoped Hub token, never on the create path.
