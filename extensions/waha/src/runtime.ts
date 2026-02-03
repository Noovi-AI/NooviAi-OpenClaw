import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setWahaRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function getWahaRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WAHA runtime not initialized - plugin not registered");
  }
  return runtime;
}
