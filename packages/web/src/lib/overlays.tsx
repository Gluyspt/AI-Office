// The overlay convention: a feature adds a slide-in panel by creating
// `src/features/<name>/overlay.tsx`, and nothing else in the app changes.
//
// This is what lets the chat panel (026) and the stop controls (029) land
// in separate tickets without either touching the other's files — the same
// property the server gets from autoloaded route files, expressed with
// Vite's import.meta.glob instead of readdir.
//
// CONTRACT for an overlay module: default-export a React component. It
// renders itself, owns its own open/closed state, and must not assume it is
// the only overlay mounted — see the stacking note below.
import { type ComponentType } from "react";

interface OverlayModule {
  readonly default: ComponentType;
}

/**
 * Eager, not lazy. An overlay is a panel the user opens, and a lazy chunk
 * would put a network round trip between the click and the panel; these are
 * small enough that paying for them at load is the better trade.
 */
const modules = import.meta.glob<OverlayModule>("../features/*/overlay.tsx", {
  eager: true,
});

export interface CollectedOverlay {
  /** The feature directory name — `chat`, `control`. Used as a React key
   * and as the stacking order, so the set is deterministic. */
  readonly name: string;
  readonly Component: ComponentType;
}

/** Sorted by feature name so mount order does not depend on however the
 * bundler happened to walk the directory. */
export function collectOverlays(): CollectedOverlay[] {
  return Object.entries(modules)
    .map(([path, module]) => {
      const name = path.split("/").at(-2) ?? path;
      return { name, Component: module.default };
    })
    .filter((entry) => typeof entry.Component === "function")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Mounts every collected overlay.
 *
 * Each gets its own stacking context and its own fixed-position host, so two
 * open at once cannot fight over z-index or clip each other: the host is
 * `pointer-events: none` and only the panel inside it takes pointer events,
 * which means a closed overlay is inert rather than an invisible click
 * blocker over the whole page.
 */
export function OverlayHost(): React.ReactElement {
  const overlays = collectOverlays();
  return (
    <div className="overlay-host" data-overlay-count={overlays.length}>
      {overlays.map(({ name, Component }) => (
        <div key={name} className="overlay-slot" data-overlay={name}>
          <Component />
        </div>
      ))}
    </div>
  );
}
