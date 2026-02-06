import type { Component, TUI } from "@mariozechner/pi-tui";
import { randomUUID } from "node:crypto";
import type { SessionsPatchResult } from "../gateway/protocol/index.js";
import type { ChatLog } from "./components/chat-log.js";
import type { GatewayChatClient } from "./gateway-chat.js";
import type {
  AgentSummary,
  GatewayStatusSummary,
  TuiOptions,
  TuiStateAccess,
} from "./tui-types.js";
import {
  formatThinkingLevels,
  normalizeUsageDisplay,
  resolveResponseUsageMode,
} from "../auto-reply/thinking.js";
import { t } from "../i18n/index.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { formatRelativeTime } from "../utils/time-format.js";
import { helpText, parseCommand } from "./commands.js";
import {
  createFilterableSelectList,
  createSearchableSelectList,
  createSettingsList,
} from "./components/selectors.js";
import { formatStatusSummary } from "./tui-status-summary.js";

type CommandHandlerContext = {
  client: GatewayChatClient;
  chatLog: ChatLog;
  tui: TUI;
  opts: TuiOptions;
  state: TuiStateAccess;
  deliverDefault: boolean;
  openOverlay: (component: Component) => void;
  closeOverlay: () => void;
  refreshSessionInfo: () => Promise<void>;
  loadHistory: () => Promise<void>;
  setSession: (key: string) => Promise<void>;
  refreshAgents: () => Promise<void>;
  abortActive: () => Promise<void>;
  setActivityStatus: (text: string) => void;
  formatSessionKey: (key: string) => string;
  applySessionInfoFromPatch: (result: SessionsPatchResult) => void;
  noteLocalRunId: (runId: string) => void;
  forgetLocalRunId?: (runId: string) => void;
};

export function createCommandHandlers(context: CommandHandlerContext) {
  const {
    client,
    chatLog,
    tui,
    opts,
    state,
    deliverDefault,
    openOverlay,
    closeOverlay,
    refreshSessionInfo,
    loadHistory,
    setSession,
    refreshAgents,
    abortActive,
    setActivityStatus,
    formatSessionKey,
    applySessionInfoFromPatch,
    noteLocalRunId,
    forgetLocalRunId,
  } = context;

  const setAgent = async (id: string) => {
    state.currentAgentId = normalizeAgentId(id);
    await setSession("");
  };

  const openModelSelector = async () => {
    try {
      const models = await client.listModels();
      if (models.length === 0) {
        chatLog.addSystem(t("tui.noModelsAvailable", {}, "no models available"));
        tui.requestRender();
        return;
      }
      const items = models.map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: `${model.provider}/${model.id}`,
        description: model.name && model.name !== model.id ? model.name : "",
      }));
      const selector = createSearchableSelectList(items, 9);
      selector.onSelect = (item) => {
        void (async () => {
          try {
            const result = await client.patchSession({
              key: state.currentSessionKey,
              model: item.value,
            });
            chatLog.addSystem(
              t("tui.modelSetTo", { model: item.value }, `model set to ${item.value}`),
            );
            applySessionInfoFromPatch(result);
            await refreshSessionInfo();
          } catch (err) {
            chatLog.addSystem(
              t("tui.modelSetFailed", { error: String(err) }, `model set failed: ${String(err)}`),
            );
          }
          closeOverlay();
          tui.requestRender();
        })();
      };
      selector.onCancel = () => {
        closeOverlay();
        tui.requestRender();
      };
      openOverlay(selector);
      tui.requestRender();
    } catch (err) {
      chatLog.addSystem(
        t("tui.modelListFailed", { error: String(err) }, `model list failed: ${String(err)}`),
      );
      tui.requestRender();
    }
  };

  const openAgentSelector = async () => {
    await refreshAgents();
    if (state.agents.length === 0) {
      chatLog.addSystem(t("tui.noAgentsFound", {}, "no agents found"));
      tui.requestRender();
      return;
    }
    const items = state.agents.map((agent: AgentSummary) => ({
      value: agent.id,
      label: agent.name ? `${agent.id} (${agent.name})` : agent.id,
      description: agent.id === state.agentDefaultId ? t("common.default", {}, "default") : "",
    }));
    const selector = createSearchableSelectList(items, 9);
    selector.onSelect = (item) => {
      void (async () => {
        closeOverlay();
        await setAgent(item.value);
        tui.requestRender();
      })();
    };
    selector.onCancel = () => {
      closeOverlay();
      tui.requestRender();
    };
    openOverlay(selector);
    tui.requestRender();
  };

  const openSessionSelector = async () => {
    try {
      const result = await client.listSessions({
        includeGlobal: false,
        includeUnknown: false,
        includeDerivedTitles: true,
        includeLastMessage: true,
        agentId: state.currentAgentId,
      });
      const items = result.sessions.map((session) => {
        const title = session.derivedTitle ?? session.displayName;
        const formattedKey = formatSessionKey(session.key);
        // Avoid redundant "title (key)" when title matches key
        const label = title && title !== formattedKey ? `${title} (${formattedKey})` : formattedKey;
        // Build description: time + message preview
        const timePart = session.updatedAt ? formatRelativeTime(session.updatedAt) : "";
        const preview = session.lastMessagePreview?.replace(/\s+/g, " ").trim();
        const description =
          timePart && preview ? `${timePart} · ${preview}` : (preview ?? timePart);
        return {
          value: session.key,
          label,
          description,
          searchText: [
            session.displayName,
            session.label,
            session.subject,
            session.sessionId,
            session.key,
            session.lastMessagePreview,
          ]
            .filter(Boolean)
            .join(" "),
        };
      });
      const selector = createFilterableSelectList(items, 9);
      selector.onSelect = (item) => {
        void (async () => {
          closeOverlay();
          await setSession(item.value);
          tui.requestRender();
        })();
      };
      selector.onCancel = () => {
        closeOverlay();
        tui.requestRender();
      };
      openOverlay(selector);
      tui.requestRender();
    } catch (err) {
      chatLog.addSystem(
        t("tui.sessionsListFailed", { error: String(err) }, `sessions list failed: ${String(err)}`),
      );
      tui.requestRender();
    }
  };

  const openSettings = () => {
    const items = [
      {
        id: "tools",
        label: t("tui.settingsToolOutput", {}, "Tool output"),
        currentValue: state.toolsExpanded ? "expanded" : "collapsed",
        values: ["collapsed", "expanded"],
      },
      {
        id: "thinking",
        label: t("tui.settingsShowThinking", {}, "Show thinking"),
        currentValue: state.showThinking ? "on" : "off",
        values: ["off", "on"],
      },
    ];
    const settings = createSettingsList(
      items,
      (id, value) => {
        if (id === "tools") {
          state.toolsExpanded = value === "expanded";
          chatLog.setToolsExpanded(state.toolsExpanded);
        }
        if (id === "thinking") {
          state.showThinking = value === "on";
          void loadHistory();
        }
        tui.requestRender();
      },
      () => {
        closeOverlay();
        tui.requestRender();
      },
    );
    openOverlay(settings);
    tui.requestRender();
  };

  const handleCommand = async (raw: string) => {
    const { name, args } = parseCommand(raw);
    if (!name) {
      return;
    }
    switch (name) {
      case "help":
        chatLog.addSystem(
          helpText({
            provider: state.sessionInfo.modelProvider,
            model: state.sessionInfo.model,
          }),
        );
        break;
      case "status":
        try {
          const status = await client.getStatus();
          if (typeof status === "string") {
            chatLog.addSystem(status);
            break;
          }
          if (status && typeof status === "object") {
            const lines = formatStatusSummary(status as GatewayStatusSummary);
            for (const line of lines) {
              chatLog.addSystem(line);
            }
            break;
          }
          chatLog.addSystem(t("tui.statusUnknownResponse", {}, "status: unknown response"));
        } catch (err) {
          chatLog.addSystem(
            t("tui.statusFailed", { error: String(err) }, `status failed: ${String(err)}`),
          );
        }
        break;
      case "agent":
        if (!args) {
          await openAgentSelector();
        } else {
          await setAgent(args);
        }
        break;
      case "agents":
        await openAgentSelector();
        break;
      case "session":
        if (!args) {
          await openSessionSelector();
        } else {
          await setSession(args);
        }
        break;
      case "sessions":
        await openSessionSelector();
        break;
      case "model":
        if (!args) {
          await openModelSelector();
        } else {
          try {
            const result = await client.patchSession({
              key: state.currentSessionKey,
              model: args,
            });
            chatLog.addSystem(t("tui.modelSetTo", { model: args }, `model set to ${args}`));
            applySessionInfoFromPatch(result);
            await refreshSessionInfo();
          } catch (err) {
            chatLog.addSystem(
              t("tui.modelSetFailed", { error: String(err) }, `model set failed: ${String(err)}`),
            );
          }
        }
        break;
      case "models":
        await openModelSelector();
        break;
      case "think":
        if (!args) {
          const levels = formatThinkingLevels(
            state.sessionInfo.modelProvider,
            state.sessionInfo.model,
            "|",
          );
          chatLog.addSystem(t("tui.thinkUsage", { levels }, `usage: /think <${levels}>`));
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            thinkingLevel: args,
          });
          chatLog.addSystem(t("tui.thinkingSetTo", { level: args }, `thinking set to ${args}`));
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(
            t("tui.thinkFailed", { error: String(err) }, `think failed: ${String(err)}`),
          );
        }
        break;
      case "verbose":
        if (!args) {
          chatLog.addSystem(t("tui.verboseUsage", {}, "usage: /verbose <on|off>"));
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            verboseLevel: args,
          });
          chatLog.addSystem(t("tui.verboseSetTo", { level: args }, `verbose set to ${args}`));
          applySessionInfoFromPatch(result);
          await loadHistory();
        } catch (err) {
          chatLog.addSystem(
            t("tui.verboseFailed", { error: String(err) }, `verbose failed: ${String(err)}`),
          );
        }
        break;
      case "reasoning":
        if (!args) {
          chatLog.addSystem(t("tui.reasoningUsage", {}, "usage: /reasoning <on|off>"));
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            reasoningLevel: args,
          });
          chatLog.addSystem(t("tui.reasoningSetTo", { level: args }, `reasoning set to ${args}`));
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(
            t("tui.reasoningFailed", { error: String(err) }, `reasoning failed: ${String(err)}`),
          );
        }
        break;
      case "usage": {
        const normalized = args ? normalizeUsageDisplay(args) : undefined;
        if (args && !normalized) {
          chatLog.addSystem(t("tui.usageUsage", {}, "usage: /usage <off|tokens|full>"));
          break;
        }
        const currentRaw = state.sessionInfo.responseUsage;
        const current = resolveResponseUsageMode(currentRaw);
        const next =
          normalized ?? (current === "off" ? "tokens" : current === "tokens" ? "full" : "off");
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            responseUsage: next === "off" ? null : next,
          });
          chatLog.addSystem(t("tui.usageFooter", { mode: next }, `usage footer: ${next}`));
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(
            t("tui.usageFailed", { error: String(err) }, `usage failed: ${String(err)}`),
          );
        }
        break;
      }
      case "elevated":
        if (!args) {
          chatLog.addSystem(t("tui.elevatedUsage", {}, "usage: /elevated <on|off|ask|full>"));
          break;
        }
        if (!["on", "off", "ask", "full"].includes(args)) {
          chatLog.addSystem(t("tui.elevatedUsage", {}, "usage: /elevated <on|off|ask|full>"));
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            elevatedLevel: args,
          });
          chatLog.addSystem(t("tui.elevatedSetTo", { level: args }, `elevated set to ${args}`));
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(
            t("tui.elevatedFailed", { error: String(err) }, `elevated failed: ${String(err)}`),
          );
        }
        break;
      case "activation":
        if (!args) {
          chatLog.addSystem(t("tui.activationUsage", {}, "usage: /activation <mention|always>"));
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            groupActivation: args === "always" ? "always" : "mention",
          });
          chatLog.addSystem(t("tui.activationSetTo", { mode: args }, `activation set to ${args}`));
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(
            t("tui.activationFailed", { error: String(err) }, `activation failed: ${String(err)}`),
          );
        }
        break;
      case "new":
      case "reset":
        try {
          // Clear token counts immediately to avoid stale display (#1523)
          state.sessionInfo.inputTokens = null;
          state.sessionInfo.outputTokens = null;
          state.sessionInfo.totalTokens = null;
          tui.requestRender();

          await client.resetSession(state.currentSessionKey);
          chatLog.addSystem(
            t(
              "tui.sessionReset",
              { key: state.currentSessionKey },
              `session ${state.currentSessionKey} reset`,
            ),
          );
          await loadHistory();
        } catch (err) {
          chatLog.addSystem(
            t("tui.resetFailed", { error: String(err) }, `reset failed: ${String(err)}`),
          );
        }
        break;
      case "abort":
        await abortActive();
        break;
      case "settings":
        openSettings();
        break;
      case "exit":
      case "quit":
        client.stop();
        tui.stop();
        process.exit(0);
        break;
      default:
        await sendMessage(raw);
        break;
    }
    tui.requestRender();
  };

  const sendMessage = async (text: string) => {
    try {
      chatLog.addUser(text);
      tui.requestRender();
      const runId = randomUUID();
      noteLocalRunId(runId);
      state.activeChatRunId = runId;
      setActivityStatus("sending");
      await client.sendChat({
        sessionKey: state.currentSessionKey,
        message: text,
        thinking: opts.thinking,
        deliver: deliverDefault,
        timeoutMs: opts.timeoutMs,
        runId,
      });
      setActivityStatus("waiting");
    } catch (err) {
      if (state.activeChatRunId) {
        forgetLocalRunId?.(state.activeChatRunId);
      }
      state.activeChatRunId = null;
      chatLog.addSystem(t("tui.sendFailed", { error: String(err) }, `send failed: ${String(err)}`));
      setActivityStatus("error");
    }
    tui.requestRender();
  };

  return {
    handleCommand,
    sendMessage,
    openModelSelector,
    openAgentSelector,
    openSessionSelector,
    openSettings,
    setAgent,
  };
}
