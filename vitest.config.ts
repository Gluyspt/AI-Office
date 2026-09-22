import { defineConfig } from "vitest/config";

// Workspace-level test runner. Projects are globbed rather than enumerated so
// a new package (packages/*) or standalone test suite (tests/*) is picked up
// automatically — see README.md's "Extension points" section, which this
// follows the same shape as.
export default defineConfig({
  test: {
    projects: ["packages/*", "tests/*"],
    // The workspace is still empty of test files (ticket 001 only adds
    // packages/shared/src/ids.ts, untested). Vitest treats "no test files"
    // as a failure by default; until a later ticket adds specs, "0 tests, no
    // error" is the correct result, not a false-red build.
    passWithNoTests: true,

    // ONE FILE AT A TIME, because the suite shares ONE database.
    //
    // Vitest runs test files in parallel workers by default, and almost
    // every suite here talks to the same Postgres. That produced two
    // recurring classes of failure, neither of which was a bug in the code
    // under test:
    //
    //   - **Timing assertions measuring contention.** 005's "ingest p95
    //     under 50ms" and 014's "claimability on a 200-task graph under
    //     100ms" are real budgets, but running them while fourteen other
    //     files hammer the same database measures the neighbours, not the
    //     thing. The ingest test reads p95 = 9ms alone and fails at 50ms
    //     under load.
    //   - **Global-state assertions.** "the newest event", "one more
    //     TaskCreated than a moment ago", "delete every event of this type"
    //     are all claims about a whole table that a concurrent worker
    //     falsifies. Five of these were found and fixed individually across
    //     005, 013 and 014 before it was clear the pattern was the problem
    //     rather than each instance.
    //
    // Serialising costs wall-clock time and buys a suite whose failures mean
    // something. The individual fixes above are kept — a test should assert
    // on its own rows regardless — but they are no longer load-bearing.
    //
    // Revisit when suites get their own databases (a schema per worker, or
    // a template database cloned per file), which is the real fix and a
    // bigger one than any ticket here owns.
    fileParallelism: false,
  },
});
