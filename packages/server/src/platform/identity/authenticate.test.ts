// The per-session credential, end to end: minted at spawn, carried in the
// pane environment, and turned back into one desk — not one account.
//
// GLU-55. Against a real database, with a fake tmux adapter, for the same
// reason sessions.test.ts is: what this can get wrong is persistence and
// identity (a hash stored where a token should be, a token that outlives its
// session, two desks resolving to the same row), and none of that is
// testable against a mocked database.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ProjectId } from "@office/shared/ids";
import { pool } from "../../core/db/pool.ts";
import { authenticateSessionToken } from "./authenticate.ts";
import {
  SESSION_TOKEN_ENV_VAR,
  bearerCredential,
  looksUnexpanded,
  mintSessionToken,
  sessionTokenHash,
} from "./token.ts";
import {
  __resetSessionsDeps,
  __setSessionsDeps,
  killSession,
  startSession,
} from "../../features/orchestrator/sessions.ts";
import type { TmuxAdapter } from "../../features/orchestrator/tmux.ts";

const createdProjects: string[] = [];
const slugOf = new Map<string, string>();

async function makeProject(): Promise<ProjectId> {
  const slug = `glu55-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `insert into projects (name, slug, repo_url) values ($1, $2, $3) returning id`,
    [slug, slug, "https://example.invalid/repo.git"],
  );
  const id = result.rows[0]!.id;
  createdProjects.push(id);
  slugOf.set(id, slug);
  return id as ProjectId;
}

/** Every `newSession` request, so a test can read the pane environment. */
let spawned: { env?: Readonly<Record<string, string>> }[] = [];

function fakeAdapter(): TmuxAdapter {
  return {
    newSession: async (request: { env?: Readonly<Record<string, string>> }) => {
      spawned.push(request);
      return { ok: true, value: { name: "x", dialogsAnswered: [], readyMs: 10 } };
    },
    hasSession: async () => ({ ok: true, value: { exists: true } }),
    listSessions: async () => ({ ok: true, value: { names: [], foreign: [] } }),
    capturePane: async () => ({ ok: true, value: { pane: "" } }),
    sendLiteral: async () => ({ ok: true, value: { byteLength: 1 } }),
    sendKeys: async () => ({ ok: true, value: {} }),
    sendEscape: async () => ({ ok: true, value: {} }),
    clearComposer: async () => ({ ok: true, value: { clears: 1 } }),
    sendMessage: async () => ({ ok: true, value: { byteLength: 1 } }),
    killSession: async () => ({ ok: true, value: {} }),
  } as unknown as TmuxAdapter;
}

beforeEach(() => {
  spawned = [];
  __setSessionsDeps({
    tmux: fakeAdapter(),
    waitForFirstEvent: async (claudeSessionId) =>
      ({
        id: randomUUID(),
        projectId: null,
        sessionId: claudeSessionId,
        type: "SessionStart",
        payload: {},
        receivedAt: "now",
        cursor: "c",
      }) as never,
  });
});

afterAll(async () => {
  __resetSessionsDeps();
  for (const id of createdProjects) {
    await pool.query("delete from projects where id = $1", [id]);
  }
});

async function start(
  overrides: Partial<Parameters<typeof startSession>[0]> = {},
): Promise<Awaited<ReturnType<typeof startSession>>["session"]> {
  const projectId = overrides.projectId ?? (await makeProject());
  const { session } = await startSession({
    projectId,
    projectSlug: slugOf.get(projectId as string) ?? `slug-${randomUUID()}`,
    role: "dept_lead",
    dept: "dev",
    owner: "agent1",
    backend: "claude",
    model: "sonnet",
    modelReason: "routine work",
    cwd: "/srv/office/projects/schedool",
    claudeBin: "/usr/local/bin/claude",
    hookArrivalTimeoutMs: 50,
    ...overrides,
  });
  return session;
}

/** The token handed to the most recent spawn. */
function tokenFromLastSpawn(): string {
  const env = spawned.at(-1)?.env ?? {};
  const token = env[SESSION_TOKEN_ENV_VAR];
  if (token === undefined) throw new Error(`${SESSION_TOKEN_ENV_VAR} was not in the pane env`);
  return token;
}

// --- The value ------------------------------------------------------------------

describe("minting", () => {
  it("produces a prefixed, unguessable token and its sha-256", () => {
    const { token, hash } = mintSessionToken();
    expect(token).toMatch(/^ost_[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(sessionTokenHash(token));
    // The hash is not the token, which is the whole reason only one of them
    // is stored.
    expect(hash).not.toContain(token);
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => mintSessionToken().token));
    expect(tokens.size).toBe(500);
  });
});

describe("looksUnexpanded", () => {
  // THE ONE THAT MATTERS. An unset variable does not fail the desk: Claude
  // Code loads the MCP config and sends the literal text, identically on
  // every affected desk. Treating that as an identity would hand every agent
  // one shared desk.
  it("spots a placeholder that was never expanded", () => {
    expect(looksUnexpanded("${OFFICE_SESSION_TOKEN}")).toBe(true);
    expect(looksUnexpanded("Bearer ${OFFICE_SESSION_TOKEN}")).toBe(true);
    expect(looksUnexpanded("${OFFICE_SESSION_TOKEN:-}")).toBe(true);
    expect(looksUnexpanded("${A_B9}")).toBe(true);
  });

  it("does not fire on a real token or on a bare dollar sign", () => {
    expect(looksUnexpanded(mintSessionToken().token)).toBe(false);
    expect(looksUnexpanded("$OFFICE_SESSION_TOKEN")).toBe(false);
    expect(looksUnexpanded("ost_${}")).toBe(false);
    expect(looksUnexpanded("price $5 {a}")).toBe(false);
  });
});

describe("bearerCredential", () => {
  it("reads the credential whatever case the scheme is written in", () => {
    expect(bearerCredential("Bearer ost_abc")).toBe("ost_abc");
    expect(bearerCredential("bearer   ost_abc  ")).toBe("ost_abc");
    expect(bearerCredential("BEARER ost_abc")).toBe("ost_abc");
  });

  it("returns null when there is no bearer credential at all", () => {
    expect(bearerCredential(undefined)).toBeNull();
    expect(bearerCredential("")).toBeNull();
    expect(bearerCredential("Basic abc")).toBeNull();
    expect(bearerCredential("Bearer")).toBeNull();
    expect(bearerCredential("Bearer    ")).toBeNull();
  });
});

// --- The spawn ------------------------------------------------------------------

describe("startSession mints the credential", () => {
  it("puts the token in the pane environment and only its hash in the row", async () => {
    const session = await start();
    const token = tokenFromLastSpawn();
    expect(token).toMatch(/^ost_/);

    const { rows } = await pool.query<{ token_hash: string | null }>(
      "select token_hash from sessions where id = $1",
      [session.id],
    );
    expect(rows[0]?.token_hash).toBe(sessionTokenHash(token));
    // The thing that must never be in the database.
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it("keeps the caller's other environment and overrides a supplied token", async () => {
    // A caller passing its own OFFICE_SESSION_TOKEN is confused or testing a
    // forgery. Either way the desk must present what the row stores, or every
    // tool call it makes is refused as `unknown` — which reads like a broken
    // MCP server rather than a bad caller.
    await start({
      env: { NODE_EXTRA_CA_CERTS: "/srv/office/tls/dev-cert.pem", OFFICE_SESSION_TOKEN: "ost_forged" },
    });
    const env = spawned.at(-1)?.env ?? {};
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/srv/office/tls/dev-cert.pem");
    expect(env[SESSION_TOKEN_ENV_VAR]).not.toBe("ost_forged");
    expect(env[SESSION_TOKEN_ENV_VAR]).toMatch(/^ost_/);
  });

  it("does not leak the token into the session record it returns", async () => {
    const session = await start();
    const token = tokenFromLastSpawn();
    expect(JSON.stringify(session)).not.toContain(token);
  });
});

// --- The identity ---------------------------------------------------------------

describe("authenticateSessionToken", () => {
  it("resolves a live desk's token to that desk", async () => {
    const session = await start();
    const result = await authenticateSessionToken(tokenFromLastSpawn());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.id).toBe(session.id);
    expect(result.session.owner).toBe("agent1");
  });

  // THE REASON THIS WHOLE THING EXISTS. One Linux account hosts several
  // desks, so an account-scoped secret would make these two indistinguishable
  // and "owner match" would degrade to "same teammate".
  it("distinguishes two desks on the SAME account", async () => {
    const one = await start({ dept: "dev", owner: "agent1" });
    const tokenOne = tokenFromLastSpawn();
    const two = await start({ dept: "research", owner: "agent1" });
    const tokenTwo = tokenFromLastSpawn();

    expect(tokenOne).not.toBe(tokenTwo);
    const first = await authenticateSessionToken(tokenOne);
    const second = await authenticateSessionToken(tokenTwo);
    expect(first.ok && first.session.id).toBe(one.id);
    expect(second.ok && second.session.id).toBe(two.id);
    expect(one.owner).toBe(two.owner);
  });

  it("stops accepting the token the moment the session ends", async () => {
    await start();
    const token = tokenFromLastSpawn();
    expect((await authenticateSessionToken(token)).ok).toBe(true);

    const session = await authenticateSessionToken(token);
    if (!session.ok) throw new Error("expected a live desk");
    await killSession(session.session.id, "test");

    const after = await authenticateSessionToken(token);
    expect(after.ok).toBe(false);
    if (after.ok) return;
    // Named, not generic: a killed desk retrying forever because it read
    // "unauthorized" is the failure this message exists to prevent.
    expect(after.kind).toBe("session_not_live");
    expect(after.message).toContain("ended");
  });

  it("refuses a literal placeholder and says where the repair is", async () => {
    const result = await authenticateSessionToken("${OFFICE_SESSION_TOKEN}");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("unexpanded");
    expect(result.message).toContain("launch environment");
    expect(result.message).toContain(SESSION_TOKEN_ENV_VAR);
  });

  it("distinguishes missing, malformed, unknown and not-live", async () => {
    expect((await authenticateSessionToken(null)) as { kind: string }).toMatchObject({
      kind: "missing",
    });
    expect((await authenticateSessionToken("   ")) as { kind: string }).toMatchObject({
      kind: "missing",
    });
    // A hook ingest token presented here: well-formed secret, wrong kind.
    expect(
      (await authenticateSessionToken("tok-secret-abc")) as { kind: string },
    ).toMatchObject({ kind: "malformed" });
    // Right shape, never issued.
    expect(
      (await authenticateSessionToken(mintSessionToken().token)) as { kind: string },
    ).toMatchObject({ kind: "unknown" });
  });

  it("never echoes the presented credential back in a refusal", async () => {
    // The refusals are returned over HTTP and land in logs. A message that
    // quoted the credential would put a working secret in both.
    const real = mintSessionToken().token;
    for (const presented of [real, "tok-secret-abc", "${OFFICE_SESSION_TOKEN}"]) {
      const result = await authenticateSessionToken(presented);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.message).not.toContain(presented);
    }
  });

  it("does not resolve a token by its hash", async () => {
    // Presenting the stored hash must not work: it is the one value an
    // attacker with database read access would have.
    await start();
    const hash = sessionTokenHash(tokenFromLastSpawn());
    const result = await authenticateSessionToken(hash);
    expect(result.ok).toBe(false);
  });
});
