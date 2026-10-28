// Providers built from the families' bindings; backs `ctx.use()` (ARCHITECTURE s.3.6).

import type { Family } from "../registry/types";
import type { Capability } from "../services/capability";
import type { ProviderId } from "../services/types";
import { type AccountComponent, scopesFor as googleScopesFor } from "./google/base";

export interface Provider {
  readonly id: ProviderId;
  /** The provider's API scopes for a set of account components. */
  scopesFor(components: readonly AccountComponent[]): string[];
  /** The implementation a family bound for `cap`, or undefined when none did. */
  get<T>(cap: Capability<T>): T | undefined;
}

export interface ProviderRegistry {
  /** Every provider id is present; one without bindings implements nothing. */
  get(id: ProviderId): Provider;
}

const PROVIDER_IDS: readonly ProviderId[] = ["google", "msgraph", "imap"];

const SCOPE_HELPERS: Partial<
  Record<ProviderId, (components: readonly AccountComponent[]) => string[]>
> = {
  google: googleScopesFor,
};

/**
 * Collects every family's bindings per provider, keyed by capability id. Two bindings of one
 * capability for one provider throw at load, so a family cannot shadow another's implementation.
 */
export function createProviderRegistry(families: readonly Family[]): ProviderRegistry {
  const impls = new Map<ProviderId, Map<string, unknown>>(
    PROVIDER_IDS.map((id) => [id, new Map<string, unknown>()]),
  );
  for (const family of families) {
    for (const [id, bindings] of Object.entries(family.bindings)) {
      const byCap = impls.get(id as ProviderId);
      if (!byCap) throw new Error(`family ${family.id}: unknown provider ${id}`);
      for (const { cap, impl } of bindings ?? []) {
        if (byCap.has(cap.id)) {
          throw new Error(`family ${family.id}: ${id} already binds capability ${cap.id}`);
        }
        if (impl === undefined || impl === null) {
          throw new Error(`family ${family.id}: ${id} binds capability ${cap.id} to nothing`);
        }
        byCap.set(cap.id, impl);
      }
    }
  }

  const providers = new Map<ProviderId, Provider>();
  for (const id of PROVIDER_IDS) {
    const byCap = impls.get(id) ?? new Map<string, unknown>();
    providers.set(
      id,
      Object.freeze({
        id,
        scopesFor(components: readonly AccountComponent[]): string[] {
          const helper = SCOPE_HELPERS[id];
          if (!helper) throw new Error(`provider ${id} has no scope helper`);
          return helper(components);
        },
        get<T>(cap: Capability<T>): T | undefined {
          return byCap.get(cap.id) as T | undefined;
        },
      }),
    );
  }

  return Object.freeze({
    get(id: ProviderId): Provider {
      const provider = providers.get(id);
      if (!provider) throw new Error(`unknown provider ${id}`);
      return provider;
    },
  });
}
