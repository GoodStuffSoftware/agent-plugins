// Typed capability keys and the bindings that implement them (ARCHITECTURE s.3.6).

import type { Component } from "../registry/types";

/** A key for one service interface. `_t` carries `T` at the type level only. */
export interface Capability<T> {
  readonly id: string;
  /** The account component that must be on to use it; null for account and meta capabilities. */
  readonly component: Component | null;
  readonly _t?: T;
}

export const capability = <T>(id: string, component: Component | null): Capability<T> => ({
  id,
  component,
});

/** One capability and its implementation for one provider. */
export type Binding = { cap: Capability<unknown>; impl: unknown };

/** Type-checks `impl` against the capability's interface. */
export const provide = <T>(cap: Capability<T>, impl: T): Binding => ({ cap, impl });
