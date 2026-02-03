import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { ResolvedWahaAccount, WahaConfig } from "./types.js";

/**
 * Normalize account ID to consistent format.
 */
export function normalizeAccountId(accountId?: string | null): string {
  if (!accountId || accountId === "default" || accountId === DEFAULT_ACCOUNT_ID) {
    return DEFAULT_ACCOUNT_ID;
  }
  return accountId;
}

/**
 * Get the WAHA config section from OpenClaw config.
 */
function getWahaConfig(cfg: OpenClawConfig): WahaConfig | undefined {
  return cfg.channels?.waha as WahaConfig | undefined;
}

/**
 * List all configured WAHA account IDs.
 */
export function listWahaAccountIds(cfg: OpenClawConfig): string[] {
  const wahaConfig = getWahaConfig(cfg);
  if (!wahaConfig) {
    return [];
  }

  const accountIds: string[] = [];

  // Add default account if configured
  if (wahaConfig.url && wahaConfig.apiKey && wahaConfig.session) {
    accountIds.push(DEFAULT_ACCOUNT_ID);
  }

  // Add named accounts
  if (wahaConfig.accounts) {
    for (const accountId of Object.keys(wahaConfig.accounts)) {
      if (!accountIds.includes(accountId)) {
        accountIds.push(accountId);
      }
    }
  }

  return accountIds;
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultWahaAccountId(cfg: OpenClawConfig): string {
  const wahaConfig = getWahaConfig(cfg);
  if (!wahaConfig) {
    return DEFAULT_ACCOUNT_ID;
  }

  // If default account has credentials, use it
  if (wahaConfig.url && wahaConfig.apiKey && wahaConfig.session) {
    return DEFAULT_ACCOUNT_ID;
  }

  // Otherwise use first named account
  const accounts = wahaConfig.accounts;
  if (accounts) {
    const firstAccountId = Object.keys(accounts)[0];
    if (firstAccountId) {
      return firstAccountId;
    }
  }

  return DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a WAHA account by ID.
 */
export function resolveWahaAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWahaAccount {
  const { cfg, accountId } = params;
  const normalizedId = normalizeAccountId(accountId);
  const wahaConfig = getWahaConfig(cfg) ?? ({} as WahaConfig);

  // Check if this is a named account
  const accountConfig = wahaConfig.accounts?.[normalizedId];

  if (normalizedId !== DEFAULT_ACCOUNT_ID && accountConfig) {
    // Named account - inherits base config but overrides with account-specific values
    const session = accountConfig.session;
    const url = wahaConfig.url ?? "";
    const apiKey = wahaConfig.apiKey ?? "";

    return {
      accountId: normalizedId,
      name: accountConfig.name ?? normalizedId,
      enabled: accountConfig.enabled ?? true,
      url,
      apiKey,
      session,
      hmacKey: wahaConfig.hmacKey,
      config: {
        ...wahaConfig,
        ...accountConfig,
        // Merge allowFrom arrays
        allowFrom: accountConfig.allowFrom ?? wahaConfig.allowFrom,
        groupAllowFrom: accountConfig.groupAllowFrom ?? wahaConfig.groupAllowFrom,
        dmPolicy: accountConfig.dmPolicy ?? wahaConfig.dmPolicy,
        groupPolicy: accountConfig.groupPolicy ?? wahaConfig.groupPolicy,
      },
    };
  }

  // Default account
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: wahaConfig.name,
    enabled: wahaConfig.enabled ?? true,
    url: wahaConfig.url ?? "",
    apiKey: wahaConfig.apiKey ?? "",
    session: wahaConfig.session ?? "default",
    hmacKey: wahaConfig.hmacKey,
    config: wahaConfig,
  };
}

/**
 * Check if an account is properly configured.
 */
export function isWahaAccountConfigured(account: ResolvedWahaAccount): boolean {
  return Boolean(account.url?.trim() && account.apiKey?.trim() && account.session?.trim());
}

/**
 * Get the credential source description.
 */
export function getWahaCredentialSource(account: ResolvedWahaAccount): "config" | "none" {
  if (account.url?.trim() && account.apiKey?.trim()) {
    return "config";
  }
  return "none";
}
