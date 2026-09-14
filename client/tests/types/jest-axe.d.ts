// jest-axe ships its matcher typed onto Jest's `jest.Matchers`, not
// Vitest's `Assertion` — its README's own suggested fix, adapted for
// this project's plain-JS + checkJs setup instead of a *.test.ts file.
// tests/setup.js is where the matcher is actually registered
// (`expect.extend(toHaveNoViolations)`); this file only makes tsc aware
// of it during `npm run typecheck`.
import "vitest";

declare module "vitest" {
  interface Assertion<T = unknown> {
    toHaveNoViolations(): T extends Promise<unknown> ? Promise<void> : void;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): void;
  }
}
