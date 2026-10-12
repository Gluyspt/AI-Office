---
id: "009"
title: Role definitions and hook config provisioning
build_step: 1
department: dev
estimated_model: opus
blocked_by: ["002", "008"]
---

# 009 — Role definitions and hook config provisioning

**Build step:** 1 — Spine
**Department:** dev
**Estimated model:** opus — role prompts decide agent behaviour, and prompt quality is the work here.
**Blocked by:** 002, 008

## Why

`claude --agent dev-lead` needs a `dev-lead` to exist, on that user's account, with the office hooks
installed. Provisioning has to be reproducible: a hand-edited settings file on the VPS is how a project
ends up with one agent silently not reporting its replies.

This ticket also establishes the **hook fragment convention** — tickets 020 and 028 add hook entries by
dropping a file into `config/hooks/fragments/`, never by editing a shared settings template.

## Scope

### Files created

- `agents/management-lead.md` — role definition: takes work from humans, splits by department, starts department leads; explicitly may not edit files
- `agents/dev-lead.md` — role definition: plans, splits, assigns, starts agents, owns merges for its department
- `config/hooks/base.settings.json` — the eight HTTP hook entries from the design
- `config/hooks/fragments/.gitkeep` — the fragment directory, with the convention documented in the file
- `packages/server/src/features/orchestrator/provision.ts` — renders `base.settings.json` merged with every fragment into the target user's own config directory (`~/.claude`), pre-trusts the project paths in their `.claude.json`, and installs the agent definitions
- `scripts/provision-user.sh` — one-shot host script that runs provisioning for a given Linux user

### Files modified

None.

## Acceptance criteria

- [x] Running `scripts/provision-user.sh gluy` writes a settings file into that user's own `~/.claude` containing all eight hook entries, and installs both agent definitions where `--agent` finds them.
- [x] Re-running is idempotent: byte-identical output, and any fragment already present is not duplicated.
- [x] Adding a file to `config/hooks/fragments/` and re-provisioning merges its hook entries in, with no edit to `base.settings.json` — verified with a temporary fragment in a test.
- [x] Two fragments registering handlers for the same hook event both survive the merge (array concatenation, not replacement).
- [ ] A session started through ticket 008's API with `--agent dev-lead` reaches `running`, and its SessionStart event arrives at the event server — this is the first end-to-end proof that provisioning worked.
- [x] `management-lead.md` states the planning constraint from the design: during planning it is read-only, may read the repo, and may not call `start_session` for workers. (Enforcement is ticket 019; the prompt states it here.)
- [x] `dev-lead.md` states that it never spawns directly, only through `start_session`.
- [x] Provisioning refuses to write outside the target user's config directory — a test passes a traversal path and asserts rejection.
- [x] **Each provisioned account has a git identity.** `user.name` and `user.email` set for the
      agent user, so `git commit` works without a flag. Found 2026-10-07 on `rtdvps`: a freshly
      provisioned `agent1` cannot commit at all —
      `fatal: unable to auto-detect email address (got 'agent1@rtdvps.(none)')`. Delivering work by
      committing is the entire premise of the office, and this fails **inside an agent's turn**,
      where a human watching the chat panel sees a confused agent rather than a host-config gap.
      Assert it by committing as the provisioned user in a scratch repo, not by reading the config
      back — `--global`, `/etc/gitconfig` and a repo-local value all satisfy a file check while
      only some of them satisfy git.
- [x] **The identity says what it is.** An agent's commits are attributable to an account a human
      never types into, so the name must identify the agent and the office rather than look like a
      person — the git log is read by the whole team and by `git blame` forever.
- [ ] The provisioner never writes a secret into the settings file; secrets are injected as environment variables at launch.

- [x] **`NODE_EXTRA_CA_CERTS` is exported into the environment every agent is launched with**, and a
      test asserts a provisioned session's environment contains it. Spike 002 verified that Claude
      Code's hook client **rejects a self-signed certificate outright** (`tlsv1 alert unknown ca`) and
      that this variable fixes it completely — and that it must be in the *launch environment*, not the
      settings file. Provisioning that emits correct hook URLs but forgets this produces an agent whose
      every hook silently fails.
- [x] **The certificate's expiry is checked at provisioning time and surfaced**, not discovered when it
      lapses. A single shared certificate means **every agent in the office goes silent on the same
      day** it expires. Issue it long-lived — it is self-signed and internal, so there is no revocation
      story worth preserving — and refuse to provision against one already expired.
- [x] **Rotating the certificate requires restarting every running agent**, and the ticket says so in
      its runbook. The launch environment is read once at spawn, exactly like hook config; a rotated
      cert does not reach a live session.

- [x] **Every agent session is launched with its permission mode set explicitly**, and a test
      asserts the provisioned launch does not rely on the default. Spike 003 observed that a bare
      `claude` starts in `⏵⏵ auto mode`, and that some commands ran with **no dialog at all**. An
      inherited mode is therefore not the conservative one, and the design's whole permissions model
      ("detect the rest via the `PermissionRequest` hook, which marks the agent blocked in the UI")
      assumes prompts actually happen. If provisioning says nothing, they may not.
- [x] **The mode is the most restrictive one under which the role's own allowlist still works** —
      pre-approval comes from the role's settings allowlist (design, "Permissions", step 1), never from
      running the agent unconstrained. **`bypassPermissions` / auto-accept is forbidden for agent
      sessions**, and a provisioned config carrying it fails the test.
- [ ] **The exact flag or settings key is confirmed against the installed build before shipping**, not
      assumed. Spike 002 saw `permission_mode` report `default` in hook payloads while the TUI showed
      "manual mode", so the vocabulary does not map cleanly and the provisioned value must be verified
      by observing a real session, not by reading the name.

      **Partly answered 2026-10-07 on the target, and the mismatch this question predicted is
      real.** `claude --help` on the installed build (**2.1.283**) gives
      `--permission-mode <mode>` with exactly these choices:

      > `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`

      **`default` is not among them** — so the value spike 002 saw reported in hook payloads is not
      a value you can pass, and anything provisioned as `"default"` is naming something the CLI
      does not accept. The build also announces on startup that **auto mode is now Claude Code's
      default**: *"Claude checks each tool call for risky actions and prompt injection before
      executing, runs the ones it assesses as lower-risk, and blocks the rest."*

      Measured consequence: `deliver --state prompt` returned `no_dialog` on every trial under both
      the inherited mode and `--permission-mode default`, because in auto mode Claude resolves
      permissions itself and no dialog is raised. **`manual` is the mode that prompts.** This is the
      concrete form of the warning above it — an inherited mode is not the conservative one — and it
      means `dontAsk` and `auto` are both disqualifying for an agent session for the same reason
      `bypassPermissions` is: the `PermissionRequest` hook the design relies on to mark an agent
      blocked in the UI never fires.

      Still open: which of `manual` / `acceptEdits` / `plan` is the most restrictive mode under
      which each role's own allowlist still works, and whether the settings-file key takes the same
      vocabulary as the flag. Both need a provisioned role, which is this ticket's own work.

## Decided

- **One config directory per Linux user. `CLAUDE_CONFIG_DIR` is not used.** Each team member has
  their own Linux account, so `$HOME` already separates their logins and their Claude state —
  `~/.claude` per person, nothing to point anywhere. Roles differ by `--agent <role>` against a
  single merged `settings.json` for that user, not by a config directory per role.

  This is the arrangement **proven working on 2026-09-22**: an agent started through
  `sudo -n -u gluy` with `CLAUDE_CONFIG_DIR` unset reached the composer and took delivery of all
  nine character classes. Every failure that day came from *setting* the variable.

  What it buys, beyond simplicity: a per-role config directory is a **fresh** config directory, and
  a fresh one triggers both the onboarding modal and the folder-trust dialog — the two blockers
  spike 002 §625 flags as hanging a newly provisioned user indefinitely. Per-user provisioning
  writes into a directory that has already been through onboarding once, interactively, by its
  owner.

  It also takes the design's open question off the critical path. "Does `CLAUDE_CONFIG_DIR` keep
  two logins authenticated at once?" (design line 724) only matters if one Linux user needs several
  logins. Under this decision none does, so the question is **deferred, not answered** — and
  nothing in steps 1–3 waits on it. The cost is that all of one person's roles share one hook set;
  since fragments are merged anyway, that is sufficient.

  Superseding note: the design's spawn example (line 121) writes
  `CLAUDE_CONFIG_DIR=/home/gluy/.claude claude --agent dev-lead`, which is a no-op — that path is
  already `gluy`'s default when the process runs as `gluy`. Ticket 007's adapter omits it.

- **Provisioning pre-trusts the project directories.** This survives the decision above, because a
  *newly created Linux user* has an empty `~/.claude` and therefore trusts nothing. The
  folder-trust dialog gates readiness and **Enter does not clear it** — an agent started in an
  untrusted directory sat on the dialog indefinitely, alive at 80 s. Trust is recorded per
  directory in `.claude.json`'s `projects` map, so provisioning adds each project path there.
  Relying on the orchestrator to answer the dialog is not a substitute: it is one more TUI string
  that changes between builds.

- **Each new team member logs in once, interactively, as themselves.** Provisioning cannot create a
  login — `/login` is a browser flow. The sequence is: create the Linux user, that person runs
  `claude` once and logs in, then `scripts/provision-user.sh <user>` writes hooks, agents and
  trust entries into the `~/.claude` they just created.

  Source: `docs/spikes/002-tmux-tui-control.md` §4, "Three spawn-path requirements"; spike 001 §8.5.

- **If a config directory is ever provisioned anyway**, it must contain its own `.claude.json`.
  `CLAUDE_CONFIG_DIR` relocates the config file as well as the credential, so a directory holding
  only credentials yields `Claude configuration file not found at: <dir>/.claude.json` and then the
  onboarding screen — session alive, composer never reached. Recorded because the failure is silent
  from the orchestrator's side.


- **Every hook URL this ticket emits is `https`**, per the system-wide decision (see the ticket index).
  `"type": "http"` remains the config keyword; only the scheme changes.
- **Provisioning must also make the agent trust the certificate.** If the event server uses a
  self-signed or local-CA cert, the launch environment needs `NODE_EXTRA_CA_CERTS` pointed at it, or
  every hook silently fails the TLS handshake and no event arrives — indistinguishable, from the
  orchestrator's side, from a hook that never fired. Whether the hook client accepts a self-signed cert
  at all is still untested; see `docs/spikes/001-hook-payloads.md`.
- **`SessionStart` must be a `command` hook, not an `http` one.** Spike 002 reproduced three times that
  `SessionStart` is never delivered to an `http` hook, while a `command` hook in the same block receives
  it every time. The design's hook block is wrong on this point, at exactly the event where a session
  first identifies itself.
- **Every hook entry carries an explicit `"timeout"`.** The default is 30 s and it stalls the turn;
  `"timeout": 2` is honoured on both hook types.
- **Hook config is read once at launch — there is no hot reload.** Re-provisioning hooks means
  restarting the agent, which this ticket must state rather than discover.

## Open questions

- [ ] The design does not say where per-user agent definitions live, or whether all three users get identical role files from one source of truth. This ticket assumes a single repo-owned set copied at provision time. Confirm before anyone hand-edits a role on the VPS.
- [ ] Carried from the design: **does `CLAUDE_CONFIG_DIR` keep two logins authenticated at once?** Ticket 002 should have answered this; if it did not, provisioning for a second user in step 9 is at risk.
- [ ] The design's "Permissions" section says to pre-approve per role in each role's settings allowlist, but lists no allowlist contents. Step 1 has two roles and a human watching, so this ticket ships an empty allowlist and relies on the PermissionRequest hook. The real allowlists need a decision before agents run unattended.
- [ ] Role prompt content beyond the responsibilities table in the design is being written fresh here. Worth a human review pass before step 2 depends on these agents behaving predictably.

## Landed 2026-10-08

Implemented by a subagent working from this ticket, finished and verified by the
orchestrating session. **29 files, 572 passed, 1 skipped, typecheck clean on all three
packages, on the real VPS kernel.**

**What was verified and what was not.** The suite passes and the three packages typecheck;
that is the claim. The acceptance criteria above have **not** been audited line by line
against the implementation, so they are left unticked deliberately rather than ticked on
the strength of a green suite. Someone closing this ticket should walk the list.

**Two things worth reading before trusting it.**

The permission-mode question this ticket raised is answered further than the measurement
went, and the extra step is **unverified**. Measured: on build 2.1.283 `--permission-mode`
takes `acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`, `default` is not among
them, and `manual` prompts. The implementation adds the claim that the *settings* key
`permissions.defaultMode` is the mirror image — canonical value `default`, with `manual`
accepted as an alias — and concludes `manual` is the one spelling valid in both places.
The conclusion is almost certainly right and is what the module writes, so the risk is
contained; but **the settings-key half of that claim was not checked against the build**,
and `PERMITTED_PERMISSION_MODES` accepting `"default"` rests on it. Cheap verification:
write `{"permissions":{"defaultMode":"default"}}` into a scratch config dir and see
whether a session starts.

`scripts/provision-user.sh` is a deliberately thin wrapper. `provision.ts` already carries
its own CLI, so the script adds only the three checks a shell makes better than Node does
— the account exists, we are root or that account, and as root pass the target's uid/gid —
and then `exec`s into the module. Writing the logic twice is how the two drift.

## Criteria audit 2026-10-10

Walked all 17 acceptance criteria against the implementation, which is what `## Landed`
above said nobody had done. **14 ticked, 3 left open on purpose.** 28 tests were added for
the ones the shipped suite never asserted: 11 in `provision.test.ts` and a new
`provision.effects.test.ts` (17) for the criteria that are only worth anything if something
real happens.

**One defect found and fixed, unrelated to any criterion.** `provision.ts` carried **two raw
NUL bytes** — the composite map key in `mergeOfficeSettings` was written as a literal NUL
rather than the `\0` escape. The runtime behaviour was correct and the suite passed, but
ripgrep classifies the file as binary and **skips it**, so the whole 1339-line module was
invisible to every `grep`/Grep search in the repo. `assertPermissionModeAllowed` is defined
there and a search for it returned only the test file. That matters here specifically: the
one-file-one-ticket convention is audited by grep, and `config.ts`'s append-only rule means
later tickets go looking for `loadXConfig` sections by searching. Now written as the escape,
same key, same behaviour, file is text. (git's own binary sniff reads only the first 8 KB, so
`git diff` never showed it — the bytes were past that.)

**Why the three are still open.**

- **Criterion 5 (a session with `--agent dev-lead` reaches `running` and its SessionStart
  arrives)** — UNVERIFIABLE-HERE. Needs a provisioned Linux account with a real Claude login,
  which is the same thing 011 exists to do. Left for 011 rather than approximated with a mock,
  because the whole value of this criterion is that it is end to end.
- **Criterion 11 (the provisioner never writes a secret into the settings file)** — **NOT MET,
  and not fixable inside this ticket.** The hook ingest token is written into all eight URLs as
  `?token=…`. The reason was stated in `provision.ts`'s header when it shipped and the audit
  **confirmed it rather than taking it on trust**: ticket 005's `hasValidToken` in
  `features/events/routes/events.ts` reads `request.query.token` and nothing else, so there is
  no shape today in which the token reaches ingest without being literal in the file. Hook
  `headers` do interpolate environment variables; `url` does not. So the fix is a two-ticket
  change — ingest learns an `Authorization` header (005's file, not ours), then these entries
  become `headers` + `allowedEnvVars` and the file is secret-free. Pinned by a test that fails
  the day ingest changes, so the decision gets revisited instead of a stale secret sitting in a
  file nobody looks at. Mitigations as shipped: 0600, owned by the account, per-account and
  separately rotatable, ingest bound to loopback.
- **Criterion 17 (the exact flag *or settings key* confirmed against the installed build)** —
  half confirmed. The flag half is measured on 2.1.283. The settings-key half
  (`permissions.defaultMode` taking canonical `default` with `manual` an alias) is still the
  **unverified claim** `## Landed` flagged, and `PERMITTED_PERMISSION_MODES` accepting
  `"default"` rests on it. The module writes `manual`, which is valid in both vocabularies, so
  the risk stays contained. One-line check, needs a box with the CLI:
  `{"permissions":{"defaultMode":"default"}}` in a scratch config dir, see if a session starts.

**What the new tests assert, and how I know they can fail.** Both load-bearing ones were
mutation-checked rather than trusted because they went green:

- Making fragment merge *replace* instead of concatenate failed 3 tests, including the real
  temporary-fragment one. This is the convention tickets 020 and 027 depend on.
- Disabling the expired-certificate guard failed the refusal test — **and left a
  `/home/office-provision-test-nobody/.claude` behind**, because the run carried on to step 4.
  The test now asserts no directory appeared, so a regression is two failed expectations
  instead of litter on someone's disk.

Criterion 9's git identity is exercised by making a **real commit** in a scratch repo with the
real values and reading `%an <%ae>` back, not by reading the config file — `--global`,
`/etc/gitconfig` and a repo-local value all satisfy a file check while only some satisfy git.
The `su`-to-the-account half stays with `scripts/provision-user.sh`, which needs root.

**Still the human's call, unchanged by this audit:** the git identity *form*. `gitIdentityFor`
ships one identity per Linux account (`AI Office agent (agent1)` /
`agent1@ai-office.invalid`) and says out loud in its docstring that this is an assumption. It
is permanent in `git log`. GLU-49.

## Reopened 2026-10-12 — MCP wiring, the allowlist, and the §3.3 trap

Spike 003 named three changes that land in this ticket's files, and all three are now in. Reopened
rather than spawning a follow-up because `provision.ts`, `agents/*.md` and
`config/hooks/base.settings.json` are this ticket's permanently; see 008's matching section for the
reasoning. **This closes 009's long-standing open question about the real `permissions.allow`
contents** (the "empty allowlist" note in `## Decided` is now historical).

### Scope added

- `agents/dev-lead.md`, `agents/management-lead.md` — an `mcpServers:` block attaching
  `office_tasks` over https, with identity in a `${OFFICE_SESSION_TOKEN}` header
- `config/hooks/base.settings.json` — `permissions.allow` names the office's own servers
- `packages/server/src/features/orchestrator/provision.ts` — `launchEnvironmentNames()`,
  `checkRoleDefinition()`, `assertAllowRuleUsable()`, and the `invalid_role_definition` error kind
- `packages/server/src/features/orchestrator/provision.test.ts` — 13 tests

### Acceptance criteria

- [x] Both role files attach the office's task server per role, through the role file's own
      `mcpServers:` frontmatter — the attachment point spike 003 §1 chose, because the file *is* the
      role and provisioning already installs it. No new launch flag, no change to `agentLaunchSpec`'s
      argv.
- [x] `permissions.allow` names `mcp__office_tasks__*` and `mcp__office_session__*` and nothing
      else. MCP tool calls require approval, and in `manual` mode an unlisted `claim_task` raises a
      `PermissionRequest` and parks the desk waiting for a human to approve every claim.
- [x] **Provisioning refuses an allow rule that globs the server segment** (`mcp__*`) and one
      containing parentheses. Both are documented Claude Code behaviour, both approve *nothing*, and
      both look permissive — the expensive direction, because the symptom is every tool prompting
      while the settings file reads as though it should not, sending whoever debugs it to the MCP
      server. Checked for the template and for fragments, and only for `mcp__` rules: `Bash(git
      push:*)` is a different grammar where the parentheses are how the rule works.
- [x] **Provisioning refuses a role file referencing a launch variable nothing sets**, with the
      known names in the message. This is the §3.3 trap caught at provisioning time: an unset
      variable does *not* fail the desk — Claude Code loads the config and sends the literal
      `${VAR}` text, identically on every affected desk, warning only in `claude mcp list` output
      that nobody reads during an unattended spawn. The known-variable list is derived from a real
      `agentLaunchSpec` plus `SESSION_TOKEN_ENV_VAR`, so adding a variable cannot leave it behind.
      `${VAR:-default}` is allowed, because that is what a default is for.
- [x] Only the frontmatter is scanned. The body is prose the model reads, where `${...}` is an
      example — scanning it would refuse a role file for documenting this very trap.
- [x] A role file's MCP url must be https, or a `${VAR}` that expands to one. The office decided
      https on every endpoint including loopback, and this url carries the desk's session token.
- [x] A role file with no `mcpServers` block **warns** rather than failing. A plain chat desk is a
      legitimate configuration — step 1's spine ran that way for weeks — but from step 2 on it is far
      more often a block lost in an edit, and the symptom is an agent with no tools to call and no
      way to know why.
- [x] The shipped role files are exercised by the check in a test, not merely assumed to pass it.

### Decided

**Server names use underscores: `office_tasks`, `office_session`.** Spike 003 §1's example wrote
`office-tasks` while §6's allowlist recommendation wrote `mcp__office_tasks__*`, and the two cannot
both be right: an allow rule's server segment must match the configured server name exactly and be
glob-free, so a hyphen/underscore mismatch names a server that does not exist and every call prompts.
Underscores win because the allowlist quote is the load-bearing half and reads consistently with tool
names (`claim_task`).

**`office_session` is in the allowlist but not yet in the role files.** An allow rule for a server
that is not attached matches nothing and costs nothing; a role file naming an endpoint 018 has not
served yet shows every desk a failed connection at startup. So the rule ships early and the
attachment is named in a comment for 018, which appends its own entry to both role files.

**`OFFICE_SESSION_TOKEN` is not set by `agentLaunchSpec`** — see 008's reopened section for why, and
`agentLaunchSpec`'s docstring for the short version. This ticket's role-file check is what makes that
split safe: it is the thing that would catch the spelling drifting apart.

### Still open after this

- ~~The **git identity form** for agent accounts (GLU-49).~~ **Decided 2026-10-12, and it reverses
  `gitIdentityFor`'s stated assumption.** The author is **the teammate who owns the desk**, with the
  agent named in a trailer — not `AI Office agent (agent1)`. Three consequences this ticket owns:

  1. **The mapping lives in config, not the schema.** `sessions.owner` is the *agent* account
     (`agent2` — see `claim.ts`'s refusal text), and agent accounts are purpose-created precisely so
     that no human login is named in the sudoers template. So nothing in the data model maps
     `agent1 → a teammate`, and the decision was that config supplies it, carried into the desk as
     `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` on the same channel as `OFFICE_SESSION_TOKEN`. No
     migration, no reopening of 008.
  2. **Each teammate supplies their own address; the office ships no default.** Following the lock-TTL
     and lane-config precedent: provisioning a desk for a teammate with no configured identity is
     refused rather than guessed, because the guess is permanent in `git log`. **Which address** each
     teammate uses is theirs to choose and is not this ticket's to pick — a personal address published
     in every agent commit of a pushed repo is a decision with a privacy cost, and a noreply alias
     reads identically in `git blame`.
  3. **Whether the agent trailer is emitted is a per-project office setting, not a build-time
     constant.** Asked for 2026-10-12: the web UI should let a project choose whether co-authorship
     shows. That is a runtime toggle plus a UI surface, which no ticket in steps 1–3 owns — it is
     step 4 (git workflow) work and is recorded on GLU-49 rather than invented here.

  **Caveat worth knowing before it bites:** the design's git workflow is **squash merge** (step 4).
  A squash collapses commits, so a trailer survives only as text in whatever body the squash builds —
  which is why the trailer should be `Co-Authored-By:` rather than a custom `Agent:` field. That form
  is git-native, rendered by GitHub, understood by tooling, and is already the convention this repo
  uses for its own commits. Attribution in an author field is stronger than attribution in a trailer;
  that is the cost of this decision, accepted knowingly.
- Whether an **appended `mcpServers:` entry** should become a manifest exception like a
  `loadXConfig()` section, so 018 (and later a graph server per project) can add one without
  reopening this ticket each time. Flagged for a human; the cost of getting it wrong either way is
  small.
