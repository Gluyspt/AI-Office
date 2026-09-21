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
  },
});
