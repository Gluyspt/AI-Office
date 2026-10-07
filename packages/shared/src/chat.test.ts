// Pure chat vocabulary and payload-reading rules.
//
// Everything in @office/shared/chat is deliberately free of I/O, which is
// what lets the rules that are easiest to get subtly wrong be tested without
// a Postgres — and this file is the one in ticket 010 that can run anywhere.
// The three it exists for are the three the spike warns about by name:
// keying on `hook_event_name` rather than on a field's presence, telling
// machine injection from a human prompt, and never turning "no reply" into
// an empty one.
import { describe, expect, it } from "vitest";
import {
  CHAT_DIRECTIONS,
  CHAT_EVENT_TYPES,
  CONVERSATION_SUBJECT_KINDS,
  OUTBOUND_DELIVERY_STATUSES,
  SEGMENT_END_REASONS,
  SEGMENT_START_REASONS,
  assistantReplyBody,
  carriesAgentReply,
  endReasonFromSessionEnd,
  inferSegmentEndReason,
  isChatDirection,
  isChatEventType,
  isOutboundDeliveryStatus,
  isSegmentEndReason,
  isMachineInjectedPrompt,
  startReasonFromSource,
  turnIdOf,
  type SegmentEndFacts,
  // `./chat.js`, not `./chat.ts`, and the difference is the package not the
  // style. @office/server sets `noEmit` + `allowImportingTsExtensions`, so
  // its tests import `./sessions.ts` happily. @office/shared EMITS
  // declarations (`declaration: true`, `outDir: dist`), where a `.ts`
  // extension on a *value* import is illegal — TS5097. Every other shared
  // module only ever imported siblings as `import type`, which TS erases, so
  // this is the first file in the package to hit it rather than a deviation
  // from an existing convention. `.js` is the standard NodeNext spelling and
  // resolves to the TypeScript source at both typecheck and test time.
} from "./chat.js";

describe("vocabularies", () => {
  it("has no duplicates and no empty entries", () => {
    const lists = {
      CHAT_DIRECTIONS,
      CONVERSATION_SUBJECT_KINDS,
      SEGMENT_START_REASONS,
      SEGMENT_END_REASONS,
      OUTBOUND_DELIVERY_STATUSES,
      CHAT_EVENT_TYPES,
    };
    for (const [name, list] of Object.entries(lists)) {
      expect(new Set(list).size, name).toBe(list.length);
      expect(list.every((entry) => entry.length > 0), name).toBe(true);
    }
  });

  // The SQL check constraints in db/migrations/0004_conversations.sql are the
  // only other copies of these three lists. There is no database here to ask,
  // so this asserts the exact membership the migration was written against —
  // a value added here without the migration (or vice versa) fails this.
  it("matches the vocabulary 0004_conversations.sql constrains", () => {
    expect([...SEGMENT_START_REASONS].sort()).toEqual(
      ["cleared", "resumed", "spawn", "unknown"].sort(),
    );
    expect([...SEGMENT_END_REASONS].sort()).toEqual(
      [
        "cleared",
        "completed",
        "crash",
        "exited",
        "model_switch",
        "paused",
        "replaced",
        "unknown",
      ].sort(),
    );
    expect([...OUTBOUND_DELIVERY_STATUSES].sort()).toEqual(
      ["delivered", "failed", "pending", "queued"].sort(),
    );
    expect([...CHAT_DIRECTIONS].sort()).toEqual(["inbound", "outbound"].sort());
  });

  it("guards accept their own members and reject neighbours", () => {
    expect(isChatDirection("inbound")).toBe(true);
    expect(isChatDirection("in")).toBe(false);
    expect(isChatDirection(undefined)).toBe(false);
    expect(isSegmentEndReason("cleared")).toBe(true);
    expect(isSegmentEndReason("clear")).toBe(false);
    expect(isOutboundDeliveryStatus("queued")).toBe(true);
    expect(isOutboundDeliveryStatus("sent")).toBe(false);
    expect(isChatEventType("ChatMessageAppended")).toBe(true);
    expect(isChatEventType("Stop")).toBe(false);
  });
});

describe("carriesAgentReply", () => {
  it("accepts Stop and nothing else", () => {
    expect(carriesAgentReply("Stop")).toBe(true);
  });

  // The single most likely way to get this ticket subtly wrong. Each of
  // these carries `last_assistant_message`, and none of them is the agent
  // talking to the office:
  //   StopFailure  -> the error banner ("API Error: 401 …")
  //   SubagentStop -> 6 of 7 observed were Claude Code's own internal agents,
  //                   carrying the TUI's suggested follow-up prompt
  it.each(["StopFailure", "SubagentStop", "PostToolUse", "stop", "", "Stop "])(
    "rejects %j even though it may carry last_assistant_message",
    (name) => {
      expect(carriesAgentReply(name)).toBe(false);
    },
  );
});

describe("assistantReplyBody", () => {
  it("returns the reply verbatim, whitespace included", () => {
    expect(assistantReplyBody({ last_assistant_message: "ready" })).toBe("ready");
    // "verbatim" is an acceptance criterion: the trim decides emptiness and
    // must not touch what is stored.
    expect(assistantReplyBody({ last_assistant_message: "  padded\n" })).toBe("  padded\n");
    const multiline = "line one\n\nline two  ";
    expect(assistantReplyBody({ last_assistant_message: multiline })).toBe(multiline);
  });

  // "A turn that ends with no assistant text does not append an empty
  // message." A turn halting *at* a tool call fires no Stop at all, so the
  // reachable shapes are a missing field and a blank one.
  it.each([
    ["absent", {}],
    ["null", { last_assistant_message: null }],
    ["empty string", { last_assistant_message: "" }],
    ["whitespace only", { last_assistant_message: "   \n\t " }],
    ["non-string", { last_assistant_message: 42 }],
    ["not an object", "Stop"],
    ["null payload", null],
  ])("returns null when the reply is %s", (_label, payload) => {
    expect(assistantReplyBody(payload)).toBeNull();
  });
});

describe("turnIdOf", () => {
  it("reads prompt_id, which every captured payload but SessionStart carries", () => {
    expect(turnIdOf({ prompt_id: "p-1" })).toBe("p-1");
    expect(turnIdOf({ prompt_id: "" })).toBeNull();
    expect(turnIdOf({})).toBeNull();
    expect(turnIdOf(undefined)).toBeNull();
  });
});

describe("isMachineInjectedPrompt", () => {
  // A finished subagent or background task is injected back into the session
  // AS A NEW USER PROMPT. Rendered naively that is a team member speaking.
  it("recognises a subagent hand-back", () => {
    const prompt =
      '<agent-message from="ac051d3d">\n[Subagent hand-back] The text below is the final report…\n  PONG\n</agent-message>';
    expect(isMachineInjectedPrompt(prompt)).toBe(true);
  });

  it("recognises a background task notification", () => {
    const prompt =
      "<task-notification>\n<task-id>bhgiwkuhz</task-id>\n<status>completed</status>\n</task-notification>";
    expect(isMachineInjectedPrompt(prompt)).toBe(true);
  });

  it("tolerates leading whitespace, since the wrapper is not column-anchored", () => {
    expect(isMachineInjectedPrompt("\n  <task-notification>\n…")).toBe(true);
  });

  it("leaves a human prompt alone, including one that merely mentions the tag", () => {
    expect(isMachineInjectedPrompt("ship it")).toBe(false);
    expect(isMachineInjectedPrompt("explain what <agent-message> means")).toBe(false);
    expect(isMachineInjectedPrompt(undefined)).toBe(false);
  });
});

describe("start and end reason mapping", () => {
  it("maps SessionStart.source, whose values are startup/clear/resume", () => {
    expect(startReasonFromSource("startup")).toBe("spawn");
    expect(startReasonFromSource("clear")).toBe("cleared");
    expect(startReasonFromSource("resume")).toBe("resumed");
    // The field is `source` on 2.1.278, not `session_start_type`, and a
    // future value must degrade rather than throw.
    expect(startReasonFromSource("something-new")).toBe("unknown");
    expect(startReasonFromSource(null)).toBe("unknown");
  });

  it("maps SessionEnd.reason, whose observed values are clear/other/prompt_input_exit", () => {
    // `clear` is the one that matters: SessionEnd with reason "clear" fires
    // while the agent KEEPS WORKING, so 008 refuses to end the desk — but it
    // absolutely ends the segment, because the claude session id rotates.
    expect(endReasonFromSessionEnd("clear")).toBe("cleared");
    expect(endReasonFromSessionEnd("prompt_input_exit")).toBe("exited");
    expect(endReasonFromSessionEnd("other")).toBe("exited");
    expect(endReasonFromSessionEnd("brand-new-reason")).toBe("unknown");
  });
});

describe("inferSegmentEndReason", () => {
  const base: SegmentEndFacts = {
    sameDesk: false,
    previousSessionStatus: "ended",
    previousModel: "claude-sonnet-5",
    newModel: "claude-sonnet-5",
    reportedReason: null,
  };

  it("prefers a reported SessionEnd reason over any inference", () => {
    expect(
      inferSegmentEndReason({ ...base, sameDesk: true, reportedReason: "prompt_input_exit" }),
    ).toBe("exited");
  });

  it("calls a new claude session on the SAME desk a clear, because nothing else rotates the id", () => {
    // On a live desk the only mechanism that rotates the session id is
    // `/clear`. `/compact` does not (measured), so this is a fact and not a
    // guess.
    expect(inferSegmentEndReason({ ...base, sameDesk: true })).toBe("cleared");
  });

  it("calls a failed predecessor a crash", () => {
    expect(inferSegmentEndReason({ ...base, previousSessionStatus: "failed" })).toBe("crash");
  });

  it("infers a model switch from a clean end on a different model", () => {
    // Live model switching is unavailable until step 11, so a switch IS a
    // respawn — which is the only reason this is inferable at all.
    expect(inferSegmentEndReason({ ...base, newModel: "claude-opus-5" })).toBe("model_switch");
  });

  it("does not claim a model switch when either model is unknown", () => {
    expect(inferSegmentEndReason({ ...base, previousModel: null })).toBe("exited");
    expect(inferSegmentEndReason({ ...base, newModel: null })).toBe("exited");
  });

  it("calls a takeover from a still-live desk `replaced`, not `crash`", () => {
    // An unnoticed crash takes this shape too, which is exactly why it is
    // its own value: saying "crash" here would be a confident guess.
    expect(inferSegmentEndReason({ ...base, previousSessionStatus: "running" })).toBe("replaced");
    expect(inferSegmentEndReason({ ...base, previousSessionStatus: "starting" })).toBe("replaced");
  });
});
