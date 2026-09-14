// Runs before every test file (vite.config.js's test.setupFiles).

// jest-dom's matchers (toBeInTheDocument, toHaveAttribute, ...) registered
// against Vitest's `expect`, not Jest's — the package ships this entry
// point specifically so it doesn't assume a Jest runtime.
import "@testing-library/jest-dom/vitest";

import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import { toHaveNoViolations } from "jest-axe";

// @testing-library/react auto-registers this itself when it detects a
// global `afterEach` (Jest's default). This project imports test
// functions explicitly rather than turning on Vitest's `globals: true`
// (matching server/vitest.config.js's convention), so nothing puts
// `afterEach` on the global object for RTL to find — without this,
// every render() in a file stacks up in the same document instead of
// being unmounted between tests.
afterEach(() => cleanup());

// `expect(await axe(container)).toHaveNoViolations()` in every primitive's
// test file (step 30 — "write axe-based component tests for each
// primitive"). jest-axe is a thin wrapper around axe-core; the "jest" in
// its name is history, not a runtime dependency — it works against any
// `expect` that supports `expect.extend`, Vitest's included.
expect.extend(toHaveNoViolations);
