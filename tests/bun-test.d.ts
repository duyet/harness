// `bun:test` accepts a per-call options argument between the label and the
// function — `describe(name, { timeout }, fn)` and `test(name, { timeout }, fn)`
// — and the runner honours it. The shipped types do not: `test` types the
// options third, after the function, and `describe` does not carry them at all,
// so the call sites in this directory are correct at runtime and wrong on
// paper. The overloads are merged in here rather than worked around at each of
// the six call sites, and rather than by editing node_modules, which the next
// `bun install` would discard.
//
// Delete this file once the bundled types carry the overloads upstream.
import type { TestOptions } from "bun:test";

declare module "bun:test" {
  interface Describe<T extends Readonly<any[]>> {
    (
      label: string,
      options: number | { timeout?: number },
      fn: (...args: T) => void,
    ): void;
  }

  interface Test<T extends ReadonlyArray<unknown>> {
    (
      label: string,
      options: number | TestOptions,
      fn: (...args: T) => void | Promise<unknown>,
    ): void;
  }
}
