import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import type { ResolvedWahaAccount, WahaMessagePayload } from "./types.js";
import { createWahaClient, type WahaClient } from "./api-client.js";
import {
  isGroupChatId,
  chatIdToE164,
  normalizeWahaTarget,
  normalizeWahaAllowEntry,
} from "./normalize.js";
import { getWahaRuntime } from "./runtime.js";
import { registerWahaWebhookHandler } from "./webhook-handler.js";

export interface MonitorWahaProviderOptions {
  account: ResolvedWahaAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookPath?: string;
}

export interface WahaProviderMonitor {
  account: ResolvedWahaAccount;
  client: WahaClient;
  stop: () => void;
}

// Track runtime state in memory
const runtimeState = new Map<
  string,
  {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
  }
>();

function recordChannelRuntimeState(params: {
  channel: string;
  accountId: string;
  state: Partial<{
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
  }>;
}): void {
  const key = `${params.channel}:${params.accountId}`;
  const existing = runtimeState.get(key) ?? {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  runtimeState.set(key, { ...existing, ...params.state });
}

export function getWahaRuntimeState(accountId: string) {
  return runtimeState.get(`waha:${accountId}`);
}

/**
 * Check if a sender is allowed based on allowFrom list and dmPolicy.
 */
function checkInboundAccessControl(params: {
  senderId: string;
  senderE164: string;
  isGroup: boolean;
  account: ResolvedWahaAccount;
}): { allowed: boolean; reason?: string } {
  const { senderId, senderE164, isGroup, account } = params;
  const pluginRuntime = getWahaRuntime();

  // Get effective policy
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const groupPolicy = account.config.groupPolicy ?? "allowlist";

  // Handle group messages
  if (isGroup) {
    if (groupPolicy === "disabled") {
      return { allowed: false, reason: "groups disabled" };
    }
    if (groupPolicy === "allowlist") {
      const groupAllowFrom = account.config.groupAllowFrom ?? [];
      const normalizedGroupAllowFrom = new Set(
        groupAllowFrom.map((e) => normalizeWahaAllowEntry(String(e))),
      );
      if (!normalizedGroupAllowFrom.has(senderE164) && !normalizedGroupAllowFrom.has(senderId)) {
        return { allowed: false, reason: "sender not in group allowlist" };
      }
    }
    return { allowed: true };
  }

  // Handle DM messages
  if (dmPolicy === "disabled") {
    return { allowed: false, reason: "DMs disabled" };
  }

  if (dmPolicy === "open") {
    return { allowed: true };
  }

  // Check allowlist (for allowlist and pairing policies)
  const configAllowFrom = account.config.allowFrom ?? [];
  const storeAllowFrom = pluginRuntime.channel.pairing.readAllowFromStore("waha") ?? [];
  const combinedAllowFrom = [...configAllowFrom.map((e) => String(e)), ...storeAllowFrom];
  const normalizedDmAllowFrom = new Set(combinedAllowFrom.map((e) => normalizeWahaAllowEntry(e)));

  if (normalizedDmAllowFrom.has(senderE164) || normalizedDmAllowFrom.has(senderId)) {
    return { allowed: true };
  }

  // For pairing policy, record the request and send pairing message
  if (dmPolicy === "pairing") {
    return { allowed: false, reason: "pairing required" };
  }

  return { allowed: false, reason: "sender not in allowlist" };
}

/**
 * Build MsgContext from WAHA message payload.
 */
function buildMsgContext(params: {
  payload: WahaMessagePayload;
  session: string;
  account: ResolvedWahaAccount;
  config: OpenClawConfig;
}) {
  const { payload, session, account, config } = params;
  const runtime = getWahaRuntime();

  // Determine sender - in groups, use participant; otherwise use from
  const senderId = payload.participant ?? payload.from;
  const senderE164 = chatIdToE164(senderId);
  const senderName = payload._data?.notifyName ?? payload.participant;
  const isGroup = isGroupChatId(payload.from);
  const chatId = payload.from;

  // Resolve agent route
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "waha",
    accountId: account.accountId,
    channelLabel: session,
    chatId,
    isGroup,
    groupId: isGroup ? chatId : undefined,
    senderId,
    senderE164,
    senderName,
  });

  // Build the message context
  const ctx = {
    // Core fields
    Body: payload.body ?? payload.caption ?? "",
    RawBody: payload.body ?? payload.caption ?? "",
    CommandBody: payload.body ?? payload.caption ?? "",
    BodyForCommands: payload.body ?? payload.caption ?? "",

    // Routing
    From: chatId,
    To: payload.to ?? session,
    SessionKey: `waha:${account.accountId}:${chatId}`,
    AccountId: account.accountId,

    // Message metadata
    MessageSid: payload.id,
    MessageSidFull: payload.id,
    Timestamp: payload.timestamp ? payload.timestamp * 1000 : Date.now(),

    // Reply context
    ReplyToId: payload.quotedMessage?.id,
    ReplyToBody: payload.quotedMessage?.body,

    // Chat type
    ChatType: isGroup ? "group" : "direct",
    GroupSubject: isGroup ? chatId : undefined,

    // Sender info
    SenderId: senderId,
    SenderE164: senderE164,
    SenderName: senderName,
    SenderTag: senderName ? `${senderName} (${senderE164})` : senderE164,

    // Channel info
    Provider: "waha",
    Surface: "waha",
    Channel: "waha",

    // Media (if present)
    MediaUrl: payload.mediaUrl,
    MediaType: payload.mimetype,

    // Location (if present)
    Location: payload.location
      ? {
          latitude: payload.location.latitude,
          longitude: payload.location.longitude,
          description: payload.location.description,
        }
      : undefined,
  };

  return { ctx, route, isGroup, senderId, senderE164 };
}

/**
 * Start monitoring WAHA provider for a specific account.
 */
export async function monitorWahaProvider(
  opts: MonitorWahaProviderOptions,
): Promise<WahaProviderMonitor> {
  const { account, config, abortSignal, webhookPath } = opts;
  const pluginRuntime = getWahaRuntime();
  const logger = pluginRuntime.logging.getChildLogger({
    channel: "waha",
    account: account.accountId,
  });

  // Create WAHA API client
  const client = createWahaClient({
    url: account.url,
    apiKey: account.apiKey,
  });

  // Record starting state
  recordChannelRuntimeState({
    channel: "waha",
    accountId: account.accountId,
    state: {
      running: true,
      lastStartAt: Date.now(),
    },
  });

  // Message handler
  const handleMessage = async (payload: WahaMessagePayload, session: string): Promise<void> => {
    const { ctx, route, isGroup, senderId, senderE164 } = buildMsgContext({
      payload,
      session,
      account,
      config,
    });

    // Record inbound activity
    recordChannelRuntimeState({
      channel: "waha",
      accountId: account.accountId,
      state: { lastInboundAt: Date.now() },
    });

    // Check access control
    const accessCheck = checkInboundAccessControl({
      senderId,
      senderE164,
      isGroup,
      account,
    });

    if (!accessCheck.allowed) {
      logger.debug?.(`dropping message from ${senderE164}: ${accessCheck.reason}`);

      // Send pairing message if needed
      if (accessCheck.reason === "pairing required") {
        const pairingReply = pluginRuntime.channel.pairing.buildPairingReply({
          channel: "waha",
          senderId: senderE164,
          senderName: ctx.SenderName,
        });

        // Record pairing request
        void pluginRuntime.channel.pairing.upsertPairingRequest({
          channel: "waha",
          senderId: senderE164,
          senderName: ctx.SenderName,
        });

        // Send pairing message
        await client.sendText({
          session: account.session,
          chatId: normalizeWahaTarget(ctx.From),
          text: pairingReply,
        });
      }
      return;
    }

    // Dispatch to auto-reply system
    const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(
      config,
      route.agentId,
    );

    try {
      await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg: config,
        dispatcherOptions: {
          responsePrefix: messagesConfig.responsePrefix,
          deliver: async (replyPayload, _info) => {
            const text = replyPayload.text ?? "";
            const mediaUrls = replyPayload.mediaUrls ?? [];

            // Send text reply
            if (text.trim()) {
              // Chunk text if needed (WhatsApp limit ~65536 but practical limit ~4096)
              const chunks = pluginRuntime.channel.text.chunkMarkdownText(text, 4000);
              for (const chunk of chunks) {
                await client.sendText({
                  session: account.session,
                  chatId: normalizeWahaTarget(ctx.From),
                  text: chunk,
                  replyTo: payload.id,
                });
              }
            }

            // Send media if present
            for (const mediaUrl of mediaUrls) {
              await client.sendImage({
                session: account.session,
                chatId: normalizeWahaTarget(ctx.From),
                file: { url: mediaUrl },
              });
            }

            // Record outbound activity
            recordChannelRuntimeState({
              channel: "waha",
              accountId: account.accountId,
              state: { lastOutboundAt: Date.now() },
            });
          },
          onError: (err, info) => {
            logger.error(`reply failed (${info.kind}): ${String(err)}`);
          },
        },
      });
    } catch (err) {
      logger.error(`auto-reply failed: ${String(err)}`);

      // Send error message
      await client
        .sendText({
          session: account.session,
          chatId: normalizeWahaTarget(ctx.From),
          text: "Sorry, I encountered an error processing your message.",
        })
        .catch((sendErr) => {
          logger.error(`error reply failed: ${String(sendErr)}`);
        });
    }
  };

  // Register webhook handler
  const unregisterWebhook = registerWahaWebhookHandler({
    account,
    config,
    webhookPath,
    onMessage: handleMessage,
    onReaction: (payload, _session) => {
      logger.debug?.(`received reaction from ${payload.from}: ${payload.reaction.text}`);
    },
    onSessionStatus: (payload, session) => {
      logger.info(`session "${session}" status changed to ${payload.status}`);
      if (payload.status === "FAILED") {
        recordChannelRuntimeState({
          channel: "waha",
          accountId: account.accountId,
          state: { lastError: "Session failed" },
        });
      }
    },
    log: (msg) => logger.debug?.(msg),
  });

  // Stop handler
  const stopHandler = () => {
    logger.info(`stopping WAHA provider for account ${account.accountId}`);
    unregisterWebhook();
    recordChannelRuntimeState({
      channel: "waha",
      accountId: account.accountId,
      state: {
        running: false,
        lastStopAt: Date.now(),
      },
    });
  };

  // Listen for abort signal
  abortSignal?.addEventListener("abort", stopHandler);

  return {
    account,
    client,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}
