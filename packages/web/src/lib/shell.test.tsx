// The shell's three conventions, each asserted the way a later ticket will
// actually use it: the status strip driven by records, the overlay glob,
// and file-based routing including a parameterised route.
import { describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useHealthConditions, SystemStatus, type HealthCondition } from "./SystemStatus.tsx";
import { collectOverlays, OverlayHost } from "./overlays.tsx";
import { collectRoutes, matchRoute, patternFromFilename } from "../main.tsx";

describe("SystemStatus", () => {
  function Harness({ onReady }: { readonly onReady: (api: ReturnType<typeof useHealthConditions>) => void }) {
    const health = useHealthConditions();
    onReady(health);
    return <SystemStatus conditions={health.conditions} />;
  }

  it("renders nothing when nothing is wrong", () => {
    render(<SystemStatus conditions={[]} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows two concurrent conditions and clears them independently", () => {
    // The interesting failures overlap: a degraded guard AND a dropped
    // socket is worse than either, and a strip showing only the newest
    // hides exactly that. Ticket 020's banner is a consumer of this.
    let api!: ReturnType<typeof useHealthConditions>;
    render(<Harness onReady={(value) => (api = value)} />);

    const socket: HealthCondition = { key: "socket", severity: "error", message: "Disconnected" };
    const guard: HealthCondition = { key: "guard", severity: "warning", message: "Guard degraded" };

    act(() => {
      api.raise(socket);
      api.raise(guard);
    });
    expect(screen.getByText("Disconnected")).toBeTruthy();
    expect(screen.getByText("Guard degraded")).toBeTruthy();

    act(() => api.clear("socket"));
    expect(screen.queryByText("Disconnected")).toBeNull();
    expect(screen.getByText("Guard degraded")).toBeTruthy();

    act(() => api.clear("guard"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("updates rather than stacks when the same key is raised twice", () => {
    // A reconnect loop must not leave fifty banners behind it.
    let api!: ReturnType<typeof useHealthConditions>;
    render(<Harness onReady={(value) => (api = value)} />);
    act(() => {
      api.raise({ key: "socket", severity: "error", message: "Disconnected" });
      api.raise({ key: "socket", severity: "warning", message: "Connecting…" });
    });
    expect(screen.queryByText("Disconnected")).toBeNull();
    expect(screen.getAllByText("Connecting…")).toHaveLength(1);
  });
});

describe("overlay convention", () => {
  it("collects overlays from the features glob without the shell knowing them", () => {
    // No features exist yet, so the honest assertion is that the host
    // mounts and reports a count. The "add a file and it renders" half is
    // proved by 026 and 029 landing without touching this file — and by
    // the count below changing when they do.
    const overlays = collectOverlays();
    render(<OverlayHost />);
    const host = document.querySelector(".overlay-host");
    expect(host).toBeTruthy();
    expect(host?.getAttribute("data-overlay-count")).toBe(String(overlays.length));
  });

  it("gives each overlay its own slot, so two cannot fight over stacking", () => {
    render(<OverlayHost />);
    const slots = document.querySelectorAll(".overlay-slot");
    const names = [...slots].map((slot) => slot.getAttribute("data-overlay"));
    // Every slot is distinctly keyed; duplicates would mean two overlays
    // sharing a stacking context.
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("file-based routing", () => {
  it("maps filenames to paths, including a parameterised one", () => {
    expect(patternFromFilename("./routes/index.tsx")).toBe("/");
    expect(patternFromFilename("./routes/tasks.tsx")).toBe("/tasks");
    // Ticket 031 adds exactly this file and main.tsx does not change.
    expect(patternFromFilename("./routes/tasks.$id.tsx")).toBe("/tasks/:id");
    expect(patternFromFilename("./routes/control.tsx")).toBe("/control");
  });

  it("resolves a parameterised route added without editing the router", () => {
    const Page = () => <div />;
    const routes = collectRoutes({
      "./routes/tasks.$id.tsx": { default: Page },
      "./routes/tasks.tsx": { default: Page },
    });
    const match = matchRoute("/tasks/abc-123", routes);
    expect(match?.params).toEqual({ id: "abc-123" });
    expect(matchRoute("/tasks", routes)?.route.pattern).toBe("/tasks");
  });

  it("prefers a static segment over a parameterised one", () => {
    const Page = () => <div />;
    const routes = collectRoutes({
      "./routes/tasks.$id.tsx": { default: Page },
      "./routes/tasks.new.tsx": { default: Page },
    });
    expect(matchRoute("/tasks/new", routes)?.route.pattern).toBe("/tasks/new");
  });

  it("excludes the shell from the route table", () => {
    const Page = () => <div />;
    const routes = collectRoutes({
      "./routes/__root.tsx": { default: Page },
      "./routes/index.tsx": { default: Page },
    });
    expect(routes.map((route) => route.pattern)).toEqual(["/"]);
  });

  it("returns null for an unrouted path rather than guessing", () => {
    const routes = collectRoutes({ "./routes/index.tsx": { default: () => <div /> } });
    expect(matchRoute("/nope", routes)).toBeNull();
  });
});
