// Registers the chat panel with ticket 022's overlay host.
//
// The contract is 022's: default-export a component, own your own
// open/closed state, do not assume you are the only overlay mounted. This
// file is collected by `import.meta.glob("../features/*/overlay.tsx")` in
// src/lib/overlays.tsx, so the panel lands without a line changing in
// `__root.tsx` or `overlays.tsx` — and ticket 029's control overlay lands
// beside it the same way.
//
//
// WHY THE DRAFT LIVES HERE AND NOT IN THE PANEL
// ----------------------------------------------
// The criterion is that closing the panel does not lose an unsent draft, and
// the panel *unmounts* when it closes — deliberately, because 022's overlay
// host gives anything an overlay renders `pointer-events: auto`, so a closed
// panel left in the DOM would be an invisible click target over the page.
// This component stays mounted (the host mounts it once, forever), so the
// drafts live here, keyed by target: reopening the same desk restores what
// you were typing, and switching to another desk does not carry your words
// across to a different agent.
//
//
// HOW A LATER TICKET ADDS SOMETHING TO THE PANEL
// -----------------------------------------------
// Ticket 027 owns `AgentControls.tsx` and `BlockedBanner.tsx` in this
// directory and owns no file that could mount them — so this file collects
// them by glob, exactly as the shell collects overlays, and a module **opts
// in** by exporting `chatSlot`:
//
//     export const chatSlot = "header";   // or "banner"
//     export default function AgentControls(props: ChatSlotProps) { ... }
//
// The opt-in is the load-bearing half. A glob that mounted every sibling
// component would hand 027's file props it never agreed to and crash the
// panel; a module without the marker is simply not mounted, which is a
// visible gap rather than a broken panel. The negative patterns keep this
// file's own neighbours (and the test file) out of the match.
import { useCallback, useState, type ComponentType } from "react";
import { ChatPanel, type ChatSlotProps } from "./ChatPanel.tsx";
import { chatTargetKey, closeChatPanel, useChatTarget } from "./useAgentChat.ts";

/** Dev-mode identity, read the same way `src/routes/__root.tsx` reads it.
 *
 * There is NO authentication until step 9. The design requires app-level
 * login because "every message, approval, and acceptance is attributed", and
 * every message this panel sends is attributed to this one name — which is
 * wrong, but visibly wrong: it is printed next to the composer and in the
 * shell header rather than hidden.
 *
 * DO NOT EXPOSE THIS APP BEYOND LOCALHOST OR A TRUSTED NETWORK. */
const DEV_IDENTITY: string = import.meta.env?.VITE_DEV_IDENTITY ?? "dev";

interface ChatSlotModule {
  readonly default: ComponentType<ChatSlotProps>;
  readonly chatSlot?: "header" | "banner";
}

const SLOT_MODULES = import.meta.glob<ChatSlotModule>(
  ["./*.tsx", "!./overlay.tsx", "!./Chat*.tsx", "!./*.test.tsx"],
  { eager: true },
);

export interface CollectedSlot {
  readonly name: string;
  readonly where: "header" | "banner";
  readonly Component: ComponentType<ChatSlotProps>;
}

/** Sorted by filename so mount order does not depend on how the bundler
 *  walked the directory — the same rule 022's `collectOverlays` applies. */
export function collectChatSlots(
  source: Record<string, ChatSlotModule> = SLOT_MODULES,
): CollectedSlot[] {
  return Object.entries(source)
    .filter(
      ([, module]) =>
        typeof module.default === "function" &&
        (module.chatSlot === "header" || module.chatSlot === "banner"),
    )
    .map(([path, module]) => ({
      name: path.split("/").at(-1) ?? path,
      where: module.chatSlot as "header" | "banner",
      Component: module.default,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export default function ChatOverlay(): React.ReactElement | null {
  const target = useChatTarget();
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});

  const key = chatTargetKey(target);
  const onDraftChange = useCallback(
    (text: string) => setDrafts((current) => ({ ...current, [key]: text })),
    [key],
  );

  // Closed: nothing in the DOM at all. The drafts above survive, because this
  // component does not unmount with the panel.
  if (target === null) return null;

  const slots = collectChatSlots();
  const context: ChatSlotProps = {
    target,
    // The slots that need conversation or desk detail read it through their
    // own hooks; what this file can hand over without reaching into the
    // panel's state is the target itself.
    conversation: null,
    desk: null,
    refresh: () => {},
  };
  const render = (where: "header" | "banner"): React.ReactElement[] =>
    slots
      .filter((slot) => slot.where === where)
      .map(({ name, Component }) => <Component key={name} {...context} />);

  return (
    <ChatPanel
      // Remounted per target: a new conversation starts from a clean panel
      // rather than inheriting the previous one's scroll position, expanded
      // action groups or in-flight state.
      key={key}
      target={target}
      author={DEV_IDENTITY}
      draft={drafts[key] ?? ""}
      onDraftChange={onDraftChange}
      onClose={closeChatPanel}
      headerSlot={render("header")}
      bannerSlot={render("banner")}
    />
  );
}
