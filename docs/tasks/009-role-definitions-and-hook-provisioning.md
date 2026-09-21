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
- `packages/server/src/orchestrator/provision.ts` — renders `base.settings.json` merged with every fragment into a user's `CLAUDE_CONFIG_DIR`, and installs the agent definitions
- `scripts/provision-user.sh` — one-shot host script that runs provisioning for a given Linux user

### Files modified

None.

## Acceptance criteria

- [ ] Running `scripts/provision-user.sh gluy` writes a settings file into that user's `CLAUDE_CONFIG_DIR` containing all eight hook entries, and installs both agent definitions where `--agent` finds them.
- [ ] Re-running is idempotent: byte-identical output, and any fragment already present is not duplicated.
- [ ] Adding a file to `config/hooks/fragments/` and re-provisioning merges its hook entries in, with no edit to `base.settings.json` — verified with a temporary fragment in a test.
- [ ] Two fragments registering handlers for the same hook event both survive the merge (array concatenation, not replacement).
- [ ] A session started through ticket 008's API with `--agent dev-lead` reaches `running`, and its SessionStart event arrives at the event server — this is the first end-to-end proof that provisioning worked.
- [ ] `management-lead.md` states the planning constraint from the design: during planning it is read-only, may read the repo, and may not call `start_session` for workers. (Enforcement is ticket 019; the prompt states it here.)
- [ ] `dev-lead.md` states that it never spawns directly, only through `start_session`.
- [ ] Provisioning refuses to write outside the target user's config directory — a test passes a traversal path and asserts rejection.
- [ ] The provisioner never writes a secret into the settings file; secrets are injected as environment variables at launch.

## Open questions

- [ ] The design does not say where per-user agent definitions live, or whether all three users get identical role files from one source of truth. This ticket assumes a single repo-owned set copied at provision time. Confirm before anyone hand-edits a role on the VPS.
- [ ] Carried from the design: **does `CLAUDE_CONFIG_DIR` keep two logins authenticated at once?** Ticket 002 should have answered this; if it did not, provisioning for a second user in step 9 is at risk.
- [ ] The design's "Permissions" section says to pre-approve per role in each role's settings allowlist, but lists no allowlist contents. Step 1 has two roles and a human watching, so this ticket ships an empty allowlist and relies on the PermissionRequest hook. The real allowlists need a decision before agents run unattended.
- [ ] Role prompt content beyond the responsibilities table in the design is being written fresh here. Worth a human review pass before step 2 depends on these agents behaving predictably.
