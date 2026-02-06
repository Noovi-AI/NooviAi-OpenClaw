import type { GatewayStatusSummary } from "./tui-types.js";
import { t } from "../i18n/index.js";
import { formatAge } from "../infra/channel-summary.js";
import { formatTokenCount } from "../utils/usage-format.js";
import { formatContextUsageLine } from "./tui-formatters.js";

export function formatStatusSummary(summary: GatewayStatusSummary) {
  const lines: string[] = [];
  lines.push(t("tui.gatewayStatus", {}, "Gateway status"));

  if (!summary.linkChannel) {
    lines.push(t("tui.linkChannelUnknown", {}, "Link channel: unknown"));
  } else {
    const linkLabel = summary.linkChannel.label ?? t("tui.linkChannel", {}, "Link channel");
    const linked = summary.linkChannel.linked === true;
    const authAge =
      linked && typeof summary.linkChannel.authAgeMs === "number"
        ? ` (${t("tui.lastRefreshed", { age: formatAge(summary.linkChannel.authAgeMs) }, `last refreshed ${formatAge(summary.linkChannel.authAgeMs)}`)})`
        : "";
    lines.push(
      `${linkLabel}: ${linked ? t("tui.linked", {}, "linked") : t("tui.notLinked", {}, "not linked")}${authAge}`,
    );
  }

  const providerSummary = Array.isArray(summary.providerSummary) ? summary.providerSummary : [];
  if (providerSummary.length > 0) {
    lines.push("");
    lines.push(t("tui.system", {}, "System:"));
    for (const line of providerSummary) {
      lines.push(`  ${line}`);
    }
  }

  const heartbeatAgents = summary.heartbeat?.agents ?? [];
  if (heartbeatAgents.length > 0) {
    const heartbeatParts = heartbeatAgents.map((agent) => {
      const agentId = agent.agentId ?? "unknown";
      if (!agent.enabled || !agent.everyMs) {
        return `${t("common.disabled", {}, "disabled")} (${agentId})`;
      }
      return `${agent.every ?? t("tui.unknown", {}, "unknown")} (${agentId})`;
    });
    lines.push("");
    lines.push(`${t("tui.heartbeat", {}, "Heartbeat")}: ${heartbeatParts.join(", ")}`);
  }

  const sessionPaths = summary.sessions?.paths ?? [];
  if (sessionPaths.length === 1) {
    lines.push(`${t("tui.sessionStore", {}, "Session store")}: ${sessionPaths[0]}`);
  } else if (sessionPaths.length > 1) {
    lines.push(`${t("tui.sessionStores", {}, "Session stores")}: ${sessionPaths.length}`);
  }

  const defaults = summary.sessions?.defaults;
  const defaultModel = defaults?.model ?? t("tui.unknown", {}, "unknown");
  const defaultCtx =
    typeof defaults?.contextTokens === "number"
      ? ` (${formatTokenCount(defaults.contextTokens)} ctx)`
      : "";
  lines.push(`${t("tui.defaultModel", {}, "Default model")}: ${defaultModel}${defaultCtx}`);

  const sessionCount = summary.sessions?.count ?? 0;
  lines.push(`${t("tui.activeSessions", {}, "Active sessions")}: ${sessionCount}`);

  const recent = Array.isArray(summary.sessions?.recent) ? summary.sessions?.recent : [];
  if (recent.length > 0) {
    lines.push(t("tui.recentSessions", {}, "Recent sessions:"));
    for (const entry of recent) {
      const ageLabel =
        typeof entry.age === "number"
          ? formatAge(entry.age)
          : t("tui.noActivity", {}, "no activity");
      const model = entry.model ?? t("tui.unknown", {}, "unknown");
      const usage = formatContextUsageLine({
        total: entry.totalTokens ?? null,
        context: entry.contextTokens ?? null,
        remaining: entry.remainingTokens ?? null,
        percent: entry.percentUsed ?? null,
      });
      const flags = entry.flags?.length ? ` | flags: ${entry.flags.join(", ")}` : "";
      lines.push(
        `- ${entry.key}${entry.kind ? ` [${entry.kind}]` : ""} | ${ageLabel} | model ${model} | ${usage}${flags}`,
      );
    }
  }

  const queued = Array.isArray(summary.queuedSystemEvents) ? summary.queuedSystemEvents : [];
  if (queued.length > 0) {
    const preview = queued.slice(0, 3).join(" | ");
    lines.push(
      `${t("tui.queuedSystemEvents", { count: queued.length }, `Queued system events (${queued.length})`)}: ${preview}`,
    );
  }

  return lines;
}
