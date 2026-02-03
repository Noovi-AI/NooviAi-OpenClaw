import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import { detectBinary } from "../../../commands/onboard-helpers.js";
import { installSignalCli } from "../../../commands/signal-install.js";
import { t } from "../../../i18n/index.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "../../../signal/accounts.js";
import { formatDocsLink } from "../../../terminal/links.js";
import { normalizeE164 } from "../../../utils.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const channel = "signal" as const;

function setSignalDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.signal?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      signal: {
        ...cfg.channels?.signal,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setSignalAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        signal: {
          ...cfg.channels?.signal,
          allowFrom,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      signal: {
        ...cfg.channels?.signal,
        accounts: {
          ...cfg.channels?.signal?.accounts,
          [accountId]: {
            ...cfg.channels?.signal?.accounts?.[accountId],
            allowFrom,
          },
        },
      },
    },
  };
}

function parseSignalAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function promptSignalAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultSignalAccountId(params.cfg);
  const resolved = resolveSignalAccount({ cfg: params.cfg, accountId });
  const existing = resolved.config.allowFrom ?? [];
  await params.prompter.note(
    t("channelOnboarding.signal.allowlistHelp", {
      docsLink: formatDocsLink("/signal", "signal"),
    }),
    t("channelOnboarding.signal.allowlistLabel"),
  );
  const entry = await params.prompter.text({
    message: t("channelOnboarding.signal.allowFromPrompt"),
    placeholder: t("channelOnboarding.signal.allowFromPlaceholder"),
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return t("channelOnboarding.common.required");
      }
      const parts = parseSignalAllowFromInput(raw);
      for (const part of parts) {
        if (part === "*") {
          continue;
        }
        if (part.toLowerCase().startsWith("uuid:")) {
          if (!part.slice("uuid:".length).trim()) {
            return t("channelOnboarding.signal.invalidUuid");
          }
          continue;
        }
        if (isUuidLike(part)) {
          continue;
        }
        if (!normalizeE164(part)) {
          return t("channelOnboarding.signal.invalidEntry", { entry: part });
        }
      }
      return undefined;
    },
  });
  const parts = parseSignalAllowFromInput(String(entry));
  const normalized = parts
    .map((part) => {
      if (part === "*") {
        return "*";
      }
      if (part.toLowerCase().startsWith("uuid:")) {
        return `uuid:${part.slice(5).trim()}`;
      }
      if (isUuidLike(part)) {
        return `uuid:${part}`;
      }
      return normalizeE164(part);
    })
    .filter(Boolean);
  const unique = [...new Set(normalized)];
  return setSignalAllowFrom(params.cfg, accountId, unique);
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Signal",
  channel,
  policyKey: "channels.signal.dmPolicy",
  allowFromKey: "channels.signal.allowFrom",
  getCurrent: (cfg) => cfg.channels?.signal?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setSignalDmPolicy(cfg, policy),
  promptAllowFrom: promptSignalAllowFrom,
};

export const signalOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listSignalAccountIds(cfg).some(
      (accountId) => resolveSignalAccount({ cfg, accountId }).configured,
    );
    const signalCliPath = cfg.channels?.signal?.cliPath ?? "signal-cli";
    const signalCliDetected = await detectBinary(signalCliPath);
    return {
      channel,
      configured,
      statusLines: [
        configured
          ? t("channelOnboarding.signal.statusConfigured")
          : t("channelOnboarding.signal.statusNeedsSetup"),
        `${signalCliDetected ? t("channelOnboarding.signal.cliFound") : t("channelOnboarding.signal.cliMissing")} (${signalCliPath})`,
      ],
      selectionHint: signalCliDetected
        ? t("channelOnboarding.signal.cliFound")
        : t("channelOnboarding.signal.cliMissing"),
      quickstartScore: signalCliDetected ? 1 : 0,
    };
  },
  configure: async ({
    cfg,
    runtime,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    options,
  }) => {
    const signalOverride = accountOverrides.signal?.trim();
    const defaultSignalAccountId = resolveDefaultSignalAccountId(cfg);
    let signalAccountId = signalOverride
      ? normalizeAccountId(signalOverride)
      : defaultSignalAccountId;
    if (shouldPromptAccountIds && !signalOverride) {
      signalAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Signal",
        currentId: signalAccountId,
        listAccountIds: listSignalAccountIds,
        defaultAccountId: defaultSignalAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveSignalAccount({
      cfg: next,
      accountId: signalAccountId,
    });
    const accountConfig = resolvedAccount.config;
    let resolvedCliPath = accountConfig.cliPath ?? "signal-cli";
    let cliDetected = await detectBinary(resolvedCliPath);
    if (options?.allowSignalInstall) {
      const wantsInstall = await prompter.confirm({
        message: cliDetected
          ? t("channelOnboarding.signal.cliDetectedReinstall")
          : t("channelOnboarding.signal.cliNotFoundInstall"),
        initialValue: !cliDetected,
      });
      if (wantsInstall) {
        try {
          const result = await installSignalCli(runtime);
          if (result.ok && result.cliPath) {
            cliDetected = true;
            resolvedCliPath = result.cliPath;
            await prompter.note(
              t("channelOnboarding.signal.cliInstalled", { path: result.cliPath }),
              t("channelOnboarding.signal.cliLabel"),
            );
          } else if (!result.ok) {
            await prompter.note(
              result.error ?? t("channelOnboarding.signal.cliInstallFailed"),
              t("channelOnboarding.signal.cliLabel"),
            );
          }
        } catch (err) {
          await prompter.note(
            t("channelOnboarding.signal.cliInstallFailedError", { error: String(err) }),
            t("channelOnboarding.signal.cliLabel"),
          );
        }
      }
    }

    if (!cliDetected) {
      await prompter.note(
        t("channelOnboarding.signal.cliNotFoundHint"),
        t("channelOnboarding.signal.cliLabel"),
      );
    }

    let account = accountConfig.account ?? "";
    if (account) {
      const keep = await prompter.confirm({
        message: t("channelOnboarding.signal.accountSetKeep", { account }),
        initialValue: true,
      });
      if (!keep) {
        account = "";
      }
    }

    if (!account) {
      account = String(
        await prompter.text({
          message: t("channelOnboarding.signal.botNumberPrompt"),
          validate: (value) => (value?.trim() ? undefined : t("channelOnboarding.common.required")),
        }),
      ).trim();
    }

    if (account) {
      if (signalAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            signal: {
              ...next.channels?.signal,
              enabled: true,
              account,
              cliPath: resolvedCliPath ?? "signal-cli",
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            signal: {
              ...next.channels?.signal,
              enabled: true,
              accounts: {
                ...next.channels?.signal?.accounts,
                [signalAccountId]: {
                  ...next.channels?.signal?.accounts?.[signalAccountId],
                  enabled: next.channels?.signal?.accounts?.[signalAccountId]?.enabled ?? true,
                  account,
                  cliPath: resolvedCliPath ?? "signal-cli",
                },
              },
            },
          },
        };
      }
    }

    await prompter.note(
      t("channelOnboarding.signal.nextStepsHelp", {
        statusCommand: formatCliCommand(
          "openclaw gateway call channels.status --params '{\"probe\":true}'",
        ),
        docsLink: formatDocsLink("/signal", "signal"),
      }),
      t("channelOnboarding.signal.nextStepsLabel"),
    );

    return { cfg: next, accountId: signalAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      signal: { ...cfg.channels?.signal, enabled: false },
    },
  }),
};
