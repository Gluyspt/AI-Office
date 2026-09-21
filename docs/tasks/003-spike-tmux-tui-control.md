---
id: "003"
title: "Spike: tmux control of a live Claude Code TUI"
build_step: 1
department: research
estimated_model: opus
blocked_by: []
---

# 003 — Spike: tmux control of a live Claude Code TUI

**Build step:** 1 — Spine
**Department:** research
**Estimated model:** opus — the failure modes are timing-dependent and need characterising, not just scripting.
**Blocked by:** none

## Why

The whole session model rests on driving an interactive TUI through `tmux send-keys`. The design
already warns that timing against a live TUI is fragile — it forbids keystroke injection for answering
permission prompts — yet relies on exactly that mechanism for chat-in and for Interrupt. Ticket 007
cannot write a correct adapter until the failure modes are known.

## Scope

### Files created

- `docs/spikes/002-tmux-tui-control.md` — findings
- `spikes/tmux/drive-session.sh` — throwaway script: start a session, send N messages, interrupt mid-turn, kill

### Files modified

None.

## Acceptance criteria

- [ ] The doc records whether `tmux send-keys -t <session> "<text>" Enter` reliably delivers a message when the agent is **idle**, **mid-turn**, and **sitting at a permission prompt** — 20 trials each, with the observed failure count for each state.
- [ ] The doc records what happens to a message sent mid-turn: queued and delivered at turn end, dropped, or interleaved into the prompt box.
- [ ] The doc records whether `send-keys Escape` halts the current turn without killing the session, and how long it takes to take effect.
- [ ] Text containing each of a double quote, a single quote, a backtick, a dollar sign, a semicolon, a newline, and a non-ASCII character is sent, and the doc records what the agent actually received. Where a different mechanism is required (`send-keys -l`, or `load-buffer` plus `paste-buffer`), the working invocation is recorded verbatim.
- [ ] The doc states whether `tmux kill-session` reliably fires SessionEnd — this decides whether lock release may depend on it in ticket 015.
- [ ] The doc records observed RSS for one idle `claude` process and one mid-turn process, as input to the per-project cap defaults.
- [ ] The doc states whether `sudo -u <user> tmux ...` run from the `office` account behaves identically to running as that user directly, including how `$HOME` and `CLAUDE_CONFIG_DIR` resolve.

## Open questions

- [ ] These are the questions — the deliverable is the answers.
- [ ] If mid-turn delivery proves unreliable, the design's chat model (a message queues until the turn ends) may need the orchestrator to hold the queue instead of tmux. Flag that to ticket 008 rather than deciding it here.
- [ ] The design does not say what Interrupt should do to a queued-but-undelivered message. Record the observed behaviour; the product decision belongs to ticket 027.
