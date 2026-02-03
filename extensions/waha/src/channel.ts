import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type ChannelStatusIssue,
} from "openclaw/plugin-sdk";
import type { ResolvedWahaAccount, WahaConfig, WahaChannelData } from "./types.js";
import {
  listWahaAccountIds,
  resolveDefaultWahaAccountId,
  resolveWahaAccount,
  normalizeAccountId,
  isWahaAccountConfigured,
  getWahaCredentialSource,
} from "./accounts.js";
import { createWahaClient } from "./api-client.js";
import { WahaConfigSchema } from "./config-schema.js";
import { monitorWahaProvider, getWahaRuntimeState } from "./monitor.js";
import {
  normalizeWahaTarget,
  looksLikeWahaTargetId,
  normalizeWahaAllowEntry,
  chatIdToE164,
} from "./normalize.js";
import { getWahaRuntime } from "./runtime.js";

// WAHA channel metadata
const meta = {
  id: "waha",
  label: "WAHA",
  selectionLabel: "WAHA (WhatsApp HTTP API)",
  detailLabel: "WAHA WhatsApp",
  docsPath: "/channels/waha",
  docsLabel: "waha",
  blurb: "WhatsApp via WAHA HTTP API (self-hosted or cloud).",
  systemImage: "message.fill",
};

export const wahaPlugin: ChannelPlugin<ResolvedWahaAccount> = {
  id: "waha",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "phoneNumber",
    normalizeAllowEntry: normalizeWahaAllowEntry,
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveWahaAccount({ cfg });
      if (!isWahaAccountConfigured(account)) {
        throw new Error("WAHA not configured");
      }
      const client = createWahaClient({ url: account.url, apiKey: account.apiKey });
      await client.sendText({
        session: account.session,
        chatId: normalizeWahaTarget(id),
        text: "OpenClaw: your access has been approved.",
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: true,
    reactions: true,
    media: true,
    nativeCommands: false,
    blockStreaming: false, // WAHA supports multiple messages
  },
  reload: { configPrefixes: ["channels.waha"] },
  configSchema: buildChannelConfigSchema(WahaConfigSchema),
  config: {
    listAccountIds: listWahaAccountIds,
    resolveAccount: (cfg, accountId) => resolveWahaAccount({ cfg, accountId }),
    defaultAccountId: resolveDefaultWahaAccountId,
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const wahaConfig = (cfg.channels?.waha ?? {}) as WahaConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            waha: {
              ...wahaConfig,
              enabled,
            },
          },
        };
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          waha: {
            ...wahaConfig,
            accounts: {
              ...wahaConfig.accounts,
              [accountId]: {
                ...wahaConfig.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const wahaConfig = (cfg.channels?.waha ?? {}) as WahaConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        // oxlint-disable-next-line no-unused-vars
        const { url, apiKey, session, hmacKey, ...rest } = wahaConfig;
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            waha: rest,
          },
        };
      }
      const accounts = { ...wahaConfig.accounts };
      delete accounts[accountId];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          waha: {
            ...wahaConfig,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account) => isWahaAccountConfigured(account),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isWahaAccountConfigured(account),
      credentialSource: getWahaCredentialSource(account),
      baseUrl: account.url,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveWahaAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map(normalizeWahaAllowEntry),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        (cfg.channels?.waha as WahaConfig | undefined)?.accounts?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.waha.accounts.${resolvedAccountId}.`
        : "channels.waha.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: "openclaw pairing approve waha <code>",
        normalizeEntry: normalizeWahaAllowEntry,
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = (cfg.channels?.defaults as { groupPolicy?: string } | undefined)
        ?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- WAHA groups: groupPolicy="open" allows any member in groups to trigger. Set channels.waha.groupPolicy="allowlist" + channels.waha.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveWahaAccount({ cfg, accountId });
      const groups = account.config.groups;
      if (!groups) {
        return false;
      }
      const groupConfig = groups[groupId] ?? groups["*"];
      return groupConfig?.requireMention ?? false;
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) {
        return undefined;
      }
      // Strip waha: prefix variants
      const stripped = trimmed.replace(/^waha:(user:|group:)?/i, "");
      // If already has WAHA suffix, keep as-is
      if (
        stripped.endsWith("@c.us") ||
        stripped.endsWith("@g.us") ||
        stripped.endsWith("@newsletter")
      ) {
        return stripped;
      }
      // Strip + from E.164
      if (stripped.startsWith("+")) {
        return stripped.slice(1);
      }
      return stripped;
    },
    targetResolver: {
      looksLikeId: looksLikeWahaTargetId,
      hint: "<phoneNumber|chatId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => {
      const wahaConfig = (cfg.channels?.waha ?? {}) as WahaConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            waha: {
              ...wahaConfig,
              name,
            },
          },
        };
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          waha: {
            ...wahaConfig,
            accounts: {
              ...wahaConfig.accounts,
              [accountId]: {
                ...wahaConfig.accounts?.[accountId],
                name,
              },
            },
          },
        },
      };
    },
    validateInput: ({ input }) => {
      const typedInput = input as {
        url?: string;
        httpUrl?: string;
        token?: string;
      };
      const url = typedInput.url ?? typedInput.httpUrl;
      const apiKey = typedInput.token;

      if (!url) {
        return "WAHA requires a URL (--url or channels.waha.url).";
      }
      if (!apiKey) {
        return "WAHA requires an API key (--token or channels.waha.apiKey).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const typedInput = input as {
        name?: string;
        url?: string;
        httpUrl?: string;
        token?: string;
        webhookPath?: string;
      };
      const wahaConfig = (cfg.channels?.waha ?? {}) as WahaConfig;
      const url = typedInput.url ?? typedInput.httpUrl;
      const apiKey = typedInput.token;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            waha: {
              ...wahaConfig,
              enabled: true,
              ...(typedInput.name ? { name: typedInput.name } : {}),
              ...(url ? { url } : {}),
              ...(apiKey ? { apiKey } : {}),
              ...(typedInput.webhookPath ? { webhookPath: typedInput.webhookPath } : {}),
            },
          },
        };
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          waha: {
            ...wahaConfig,
            enabled: true,
            // Base URL and API key are shared across accounts
            ...(url ? { url } : {}),
            ...(apiKey ? { apiKey } : {}),
            accounts: {
              ...wahaConfig.accounts,
              [accountId]: {
                ...wahaConfig.accounts?.[accountId],
                enabled: true,
                session: accountId, // Account ID is the WAHA session name
                ...(typedInput.name ? { name: typedInput.name } : {}),
                ...(typedInput.webhookPath ? { webhookPath: typedInput.webhookPath } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getWahaRuntime().channel.text.chunkMarkdownText(text, limit),
    textChunkLimit: 4000, // WhatsApp practical limit
    pollMaxOptions: 12, // WhatsApp poll limit
    sendPayload: async ({ to, payload, accountId, cfg }) => {
      const runtime = getWahaRuntime();
      const account = resolveWahaAccount({ cfg, accountId });
      if (!isWahaAccountConfigured(account)) {
        throw new Error("WAHA not configured");
      }

      const client = createWahaClient({ url: account.url, apiKey: account.apiKey });
      const chatId = normalizeWahaTarget(to);
      const wahaData = (payload.channelData?.waha as WahaChannelData | undefined) ?? {};

      let lastResult: { id: string } | null = null;

      // Send text
      const text = payload.text ?? "";
      if (text.trim()) {
        const chunks = runtime.channel.text.chunkMarkdownText(text, 4000);
        for (const chunk of chunks) {
          lastResult = await client.sendText({
            session: account.session,
            chatId,
            text: chunk,
          });
        }
      }

      // Send media
      const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      for (const mediaUrl of mediaUrls) {
        lastResult = await client.sendImage({
          session: account.session,
          chatId,
          file: { url: mediaUrl },
        });
      }

      // Send location if present
      if (wahaData.location) {
        lastResult = await client.sendLocation({
          session: account.session,
          chatId,
          latitude: wahaData.location.latitude,
          longitude: wahaData.location.longitude,
          title: wahaData.location.title,
          address: wahaData.location.address,
        });
      }

      return {
        channel: "waha",
        messageId: lastResult?.id ?? "sent",
        chatId,
      };
    },
    sendText: async ({ to, text, accountId, cfg }) => {
      const runtime = getWahaRuntime();
      const account = resolveWahaAccount({ cfg, accountId });
      if (!isWahaAccountConfigured(account)) {
        throw new Error("WAHA not configured");
      }

      const client = createWahaClient({ url: account.url, apiKey: account.apiKey });
      const chatId = normalizeWahaTarget(to);

      const chunks = runtime.channel.text.chunkMarkdownText(text, 4000);
      let lastResult: { id: string } | null = null;

      for (const chunk of chunks) {
        lastResult = await client.sendText({
          session: account.session,
          chatId,
          text: chunk,
        });
      }

      return {
        channel: "waha",
        messageId: lastResult?.id ?? "sent",
        chatId,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const account = resolveWahaAccount({ cfg, accountId });
      if (!isWahaAccountConfigured(account)) {
        throw new Error("WAHA not configured");
      }

      const client = createWahaClient({ url: account.url, apiKey: account.apiKey });
      const chatId = normalizeWahaTarget(to);

      const result = await client.sendImage({
        session: account.session,
        chatId,
        file: { url: mediaUrl },
        caption: text,
      });

      return {
        channel: "waha",
        messageId: result.id,
        chatId,
      };
    },
    sendPoll: async ({ to, poll, accountId, cfg }) => {
      const account = resolveWahaAccount({ cfg, accountId });
      if (!isWahaAccountConfigured(account)) {
        throw new Error("WAHA not configured");
      }

      const client = createWahaClient({ url: account.url, apiKey: account.apiKey });
      const chatId = normalizeWahaTarget(to);

      const result = await client.sendPoll({
        session: account.session,
        chatId,
        name: poll.question,
        options: poll.options,
        allowMultiple: poll.allowMultipleAnswers,
      });

      return {
        messageId: result.id,
        toJid: chatId,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) => {
      const issues: ChannelStatusIssue[] = [];
      for (const account of accounts) {
        const accountId = account.accountId ?? DEFAULT_ACCOUNT_ID;
        if (!account.baseUrl) {
          issues.push({
            channel: "waha",
            accountId,
            kind: "config",
            message: "WAHA URL not configured",
          });
        }
        if (!account.credentialSource || account.credentialSource === "none") {
          issues.push({
            channel: "waha",
            accountId,
            kind: "config",
            message: "WAHA API key not configured",
          });
        }
      }
      return issues;
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      credentialSource: snapshot.credentialSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      baseUrl: snapshot.baseUrl ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      if (!isWahaAccountConfigured(account)) {
        return { ok: false, error: "Not configured" };
      }

      const client = createWahaClient({
        url: account.url,
        apiKey: account.apiKey,
        timeoutMs,
      });

      try {
        const session = await client.getSession(account.session);
        const me = await client.getMe(account.session);
        return {
          ok: session.status === "WORKING",
          session: {
            name: session.name,
            status: session.status,
          },
          me: me
            ? {
                id: me.id,
                pushName: me.pushName,
                e164: chatIdToE164(me.id),
              }
            : null,
        };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = isWahaAccountConfigured(account);
      const runtimeState = getWahaRuntimeState(account.accountId);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        credentialSource: getWahaCredentialSource(account),
        baseUrl: account.url,
        running: runtimeState?.running ?? runtime?.running ?? false,
        lastStartAt: runtimeState?.lastStartAt ?? runtime?.lastStartAt ?? null,
        lastStopAt: runtimeState?.lastStopAt ?? runtime?.lastStopAt ?? null,
        lastError: runtimeState?.lastError ?? runtime?.lastError ?? null,
        lastInboundAt: runtimeState?.lastInboundAt ?? runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtimeState?.lastOutboundAt ?? runtime?.lastOutboundAt ?? null,
        mode: "webhook",
        probe,
        lastProbeAt: probe ? Date.now() : null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;

      let sessionLabel = "";
      try {
        const client = createWahaClient({ url: account.url, apiKey: account.apiKey });
        const session = await client.getSession(account.session);
        if (session.status === "WORKING") {
          const me = await client.getMe(account.session);
          if (me?.pushName) {
            sessionLabel = ` (${me.pushName})`;
          }
        }
      } catch (err) {
        if (getWahaRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] session probe failed: ${String(err)}`);
        }
      }

      ctx.log?.info(`[${account.accountId}] starting WAHA provider${sessionLabel}`);

      return monitorWahaProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath,
      });
    },
    loginWithQrStart: async ({ accountId, timeoutMs }) => {
      const cfg = getWahaRuntime().config.loadConfig();
      const account = resolveWahaAccount({ cfg, accountId });

      if (!account.url || !account.apiKey) {
        return {
          message: "WAHA URL and API key must be configured first.",
        };
      }

      const client = createWahaClient({
        url: account.url,
        apiKey: account.apiKey,
        timeoutMs,
      });

      try {
        // Check session status first
        let session = await client.getSession(account.session).catch(() => null);

        // If session doesn't exist, create it
        if (!session) {
          session = await client.createSession({
            name: account.session,
            start: true,
          });
        } else if (session.status === "STOPPED") {
          // Start the session if stopped
          session = await client.startSession(account.session);
        }

        // If already connected, no QR needed
        if (session.status === "WORKING") {
          return {
            message: `Session "${account.session}" is already connected.`,
          };
        }

        // Get QR code
        const qrDataUrl = await client.getQrCodeDataUrl(account.session);

        return {
          qrDataUrl,
          message: "Scan the QR code with WhatsApp to connect.",
        };
      } catch (err) {
        return {
          message: `Failed to get QR code: ${String(err)}`,
        };
      }
    },
    loginWithQrWait: async ({ accountId, timeoutMs }) => {
      const cfg = getWahaRuntime().config.loadConfig();
      const account = resolveWahaAccount({ cfg, accountId });

      if (!account.url || !account.apiKey) {
        return {
          connected: false,
          message: "WAHA not configured.",
        };
      }

      const client = createWahaClient({
        url: account.url,
        apiKey: account.apiKey,
        timeoutMs,
      });

      const maxWait = timeoutMs ?? 60_000;
      const startTime = Date.now();
      const pollInterval = 2000;

      while (Date.now() - startTime < maxWait) {
        try {
          const session = await client.getSession(account.session);

          if (session.status === "WORKING") {
            const me = await client.getMe(account.session);
            return {
              connected: true,
              message: me?.pushName
                ? `Connected as ${me.pushName} (${chatIdToE164(me.id)})`
                : "Connected successfully.",
            };
          }

          if (session.status === "FAILED") {
            return {
              connected: false,
              message: "Session authentication failed.",
            };
          }
        } catch {
          // Ignore errors during polling
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      return {
        connected: false,
        message: "Timed out waiting for QR code scan.",
      };
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const account = resolveWahaAccount({ cfg, accountId });
      let loggedOut = false;
      let cleared = false;

      // Logout from WAHA session if configured
      if (isWahaAccountConfigured(account)) {
        try {
          const client = createWahaClient({ url: account.url, apiKey: account.apiKey });
          await client.logoutSession(account.session);
          loggedOut = true;
        } catch {
          // Session may not exist
        }
      }

      // Clear config
      const wahaConfig = (cfg.channels?.waha ?? {}) as WahaConfig;
      let nextCfg = { ...cfg };
      let changed = false;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        if (wahaConfig.url || wahaConfig.apiKey || wahaConfig.session) {
          // oxlint-disable-next-line no-unused-vars
          const { url, apiKey, session, hmacKey, ...rest } = wahaConfig;
          nextCfg = {
            ...nextCfg,
            channels: {
              ...nextCfg.channels,
              waha: rest,
            },
          };
          cleared = true;
          changed = true;
        }
      } else {
        const accounts = wahaConfig.accounts ? { ...wahaConfig.accounts } : undefined;
        if (accounts && accountId in accounts) {
          delete accounts[accountId];
          nextCfg = {
            ...nextCfg,
            channels: {
              ...nextCfg.channels,
              waha: {
                ...wahaConfig,
                accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
              },
            },
          };
          cleared = true;
          changed = true;
        }
      }

      if (changed) {
        await getWahaRuntime().config.writeConfigFile(nextCfg);
      }

      return { cleared, loggedOut };
    },
  },
  heartbeat: {
    checkReady: async ({ cfg, accountId }) => {
      const account = resolveWahaAccount({ cfg, accountId });

      if (!isWahaAccountConfigured(account)) {
        return { ok: false, reason: "WAHA not configured" };
      }

      try {
        const client = createWahaClient({
          url: account.url,
          apiKey: account.apiKey,
          timeoutMs: 5000,
        });
        const session = await client.getSession(account.session);

        if (session.status === "WORKING") {
          return { ok: true, reason: "Session connected" };
        }

        return { ok: false, reason: `Session status: ${session.status}` };
      } catch (err) {
        return { ok: false, reason: `Health check failed: ${String(err)}` };
      }
    },
  },
};
