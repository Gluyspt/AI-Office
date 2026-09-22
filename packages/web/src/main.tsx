// Mount, plus the file-based router the route convention rests on.
//
// WHY NOT A ROUTER LIBRARY
// -------------------------
// The property this ticket has to deliver is that a later ticket adds a
// page by creating `src/routes/<name>.tsx` and editing nothing else. Most
// file-routing libraries deliver that by generating a route tree into a
// checked-in file — which every later ticket's diff then touches, and which
// two tickets landing together conflict on. That trades the guarantee for
// the appearance of it.
//
// So routes are collected with `import.meta.glob`, the same mechanism
// overlays use here and readdir-autoloading uses on the server. Consistency
// with the rest of the repo, no codegen step, no shared generated file.
//
// FILENAME CONVENTION
//   index.tsx        -> /
//   tasks.tsx        -> /tasks
//   tasks.$id.tsx    -> /tasks/:id
//   control.tsx      -> /control
//   __root.tsx       -> the shell; not a route
//
// A route module default-exports a component. A parameterised one receives
// `params`. Ticket 031 adds `tasks.$id.tsx` and this file does not change —
// asserted by a test.
import { StrictMode, useEffect, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import Root from "./routes/__root.tsx";
import "./styles/global.css";

export interface RouteParams {
  readonly [key: string]: string;
}

export interface RouteComponentProps {
  readonly params: RouteParams;
}

interface RouteModule {
  readonly default: ComponentType<RouteComponentProps>;
}

export interface RouteDefinition {
  /** `/tasks/:id` */
  readonly pattern: string;
  readonly segments: readonly string[];
  readonly Component: ComponentType<RouteComponentProps>;
}

const modules = import.meta.glob<RouteModule>("./routes/*.tsx", { eager: true });

/** `tasks.$id.tsx` -> `/tasks/:id`; `index.tsx` -> `/`. */
export function patternFromFilename(filename: string): string {
  const base = filename.replace(/^.*\//, "").replace(/\.tsx$/, "");
  if (base === "index") return "/";
  const segments = base
    .split(".")
    .map((segment) => (segment.startsWith("$") ? `:${segment.slice(1)}` : segment));
  return `/${segments.join("/")}`;
}

export function collectRoutes(
  source: Record<string, RouteModule> = modules,
): RouteDefinition[] {
  return Object.entries(source)
    .filter(([path]) => !path.includes("__root"))
    .map(([path, module]) => {
      const pattern = patternFromFilename(path);
      return {
        pattern,
        segments: pattern.split("/").filter(Boolean),
        Component: module.default,
      };
    })
    .filter((route) => typeof route.Component === "function")
    // Static segments before parameterised ones, so `/tasks/new` wins over
    // `/tasks/:id` if a later ticket adds both.
    .sort((a, b) => {
      const aParams = a.segments.filter((s) => s.startsWith(":")).length;
      const bParams = b.segments.filter((s) => s.startsWith(":")).length;
      return aParams - bParams || a.pattern.localeCompare(b.pattern);
    });
}

export interface RouteMatch {
  readonly route: RouteDefinition;
  readonly params: RouteParams;
}

export function matchRoute(
  pathname: string,
  routes: readonly RouteDefinition[],
): RouteMatch | null {
  const actual = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.segments.length !== actual.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < route.segments.length; i += 1) {
      const expected = route.segments[i]!;
      const got = actual[i]!;
      if (expected.startsWith(":")) {
        params[expected.slice(1)] = decodeURIComponent(got);
        continue;
      }
      if (expected !== got) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

function NotFound({ pathname }: { readonly pathname: string }): React.ReactElement {
  return (
    <section className="page">
      <h1>Not found</h1>
      <p>
        Nothing is routed at <code>{pathname}</code>.
      </p>
    </section>
  );
}

export function App(): React.ReactElement {
  const [pathname, setPathname] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname,
  );

  useEffect(() => {
    const onPop = (): void => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPop);

    // Nav links are plain <a href>, so later tickets can link to pages that
    // do not exist yet without importing anything from here. This upgrades
    // same-origin clicks to client-side navigation; anything modified,
    // external, or targeted is left to the browser.
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || !href.startsWith("/")) return;
      if (anchor.hasAttribute("target") || anchor.hasAttribute("download")) return;
      event.preventDefault();
      window.history.pushState({}, "", href);
      setPathname(href.split("?")[0]!.split("#")[0]!);
    };
    document.addEventListener("click", onClick);

    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, []);

  const routes = collectRoutes();
  const match = matchRoute(pathname, routes);

  return (
    <Root pathname={pathname}>
      {match ? (
        <match.route.Component params={match.params} />
      ) : (
        <NotFound pathname={pathname} />
      )}
    </Root>
  );
}

// Guarded so importing this module in a test does not try to mount.
const container = typeof document === "undefined" ? null : document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
