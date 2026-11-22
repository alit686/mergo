import type { ProviderId } from "../types";
import { cometapiAdapter } from "./cometapi";
import { kieAdapter } from "./kie";
import type { ProviderAdapter } from "./types";

const adapters: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  return adapters[provider];
}

export type { AdapterInput, ProviderAdapter, ProviderCheckResult } from "./types";
