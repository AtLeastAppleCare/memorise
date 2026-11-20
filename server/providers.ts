import { PROVIDERS } from "../shared/memory";
import type { PluginOpenSupport } from "@getpaseo/plugin/server";

export type Provider = (typeof PROVIDERS)[number];

// Only these adapters have the tool lockdown used by background workers. This is not feature support.
export function supportedProvider(provider: string): Provider | null {
  return (PROVIDERS as readonly string[]).includes(provider) ? (provider as Provider) : null;
}

export function workerAdapter(adapter: PluginOpenSupport["adapter"]): Provider | null {
  return adapter.kind === "builtin" ? supportedProvider(adapter.id) : null;
}
