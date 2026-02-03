import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter } from "../onboarding-types.js";
import { loginWeb } from "../../../channel-web.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import { mergeWhatsAppConfig } from "../../../config/merge-config.js";
import { t } from "../../../i18n/index.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import { normalizeE164 } from "../../../utils.js";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAuthDir,
} from "../../../web/accounts.js";
import { promptAccountId } from "./helpers.js";

const channel = "whatsapp" as const;

function setWhatsAppDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  return mergeWhatsAppConfig(cfg, { dmPolicy });
}

function setWhatsAppAllowFrom(cfg: OpenClawConfig, allowFrom?: string[]): OpenClawConfig {
  return mergeWhatsAppConfig(cfg, { allowFrom }, { unsetOnUndefined: ["allowFrom"] });
}

function setWhatsAppSelfChatMode(cfg: OpenClawConfig, selfChatMode: boolean): OpenClawConfig {
  return mergeWhatsAppConfig(cfg, { selfChatMode });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectWhatsAppLinked(cfg: OpenClawConfig, accountId: string): Promise<boolean> {
  const { authDir } = resolveWhatsAppAuthDir({ cfg, accountId });
  const credsPath = path.join(authDir, "creds.json");
  return await pathExists(credsPath);
}

async function promptWhatsAppAllowFrom(
  cfg: OpenClawConfig,
  _runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options?: { forceAllowlist?: boolean },
): Promise<OpenClawConfig> {
  const existingPolicy = cfg.channels?.whatsapp?.dmPolicy ?? "pairing";
  const existingAllowFrom = cfg.channels?.whatsapp?.allowFrom ?? [];
  const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";

  if (options?.forceAllowlist) {
    await prompter.note(
      t("channelOnboarding.whatsapp.needOwnerNumber"),
      t("channelOnboarding.whatsapp.numberLabel"),
    );
    const entry = await prompter.text({
      message: t("channelOnboarding.whatsapp.personalNumberPrompt"),
      placeholder: t("channelOnboarding.whatsapp.numberPlaceholder"),
      initialValue: existingAllowFrom[0],
      validate: (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) {
          return t("channelOnboarding.common.required");
        }
        const normalized = normalizeE164(raw);
        if (!normalized) {
          return t("channelOnboarding.whatsapp.invalidNumber", { number: raw });
        }
        return undefined;
      },
    });
    const normalized = normalizeE164(String(entry).trim());
    const merged = [
      ...existingAllowFrom
        .filter((item) => item !== "*")
        .map((item) => normalizeE164(item))
        .filter(Boolean),
      normalized,
    ];
    const unique = [...new Set(merged.filter(Boolean))];
    let next = setWhatsAppSelfChatMode(cfg, true);
    next = setWhatsAppDmPolicy(next, "allowlist");
    next = setWhatsAppAllowFrom(next, unique);
    await prompter.note(
      t("channelOnboarding.whatsapp.allowlistEnabled", { number: normalized }),
      t("channelOnboarding.whatsapp.allowlistLabel"),
    );
    return next;
  }

  await prompter.note(
    t("channelOnboarding.whatsapp.dmAccessHelp", {
      policy: existingPolicy,
      allowFrom: existingLabel,
      docsLink: formatDocsLink("/whatsapp", "whatsapp"),
    }),
    t("channelOnboarding.whatsapp.dmAccessLabel"),
  );

  const phoneMode = await prompter.select({
    message: t("channelOnboarding.whatsapp.phoneSetupPrompt"),
    options: [
      { value: "personal", label: t("channelOnboarding.whatsapp.personalPhone") },
      { value: "separate", label: t("channelOnboarding.whatsapp.separatePhone") },
    ],
  });

  if (phoneMode === "personal") {
    await prompter.note(
      t("channelOnboarding.whatsapp.needOwnerNumber"),
      t("channelOnboarding.whatsapp.numberLabel"),
    );
    const entry = await prompter.text({
      message: t("channelOnboarding.whatsapp.personalNumberPrompt"),
      placeholder: t("channelOnboarding.whatsapp.numberPlaceholder"),
      initialValue: existingAllowFrom[0],
      validate: (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) {
          return t("channelOnboarding.common.required");
        }
        const normalized = normalizeE164(raw);
        if (!normalized) {
          return t("channelOnboarding.whatsapp.invalidNumber", { number: raw });
        }
        return undefined;
      },
    });
    const normalized = normalizeE164(String(entry).trim());
    const merged = [
      ...existingAllowFrom
        .filter((item) => item !== "*")
        .map((item) => normalizeE164(item))
        .filter(Boolean),
      normalized,
    ];
    const unique = [...new Set(merged.filter(Boolean))];
    let next = setWhatsAppSelfChatMode(cfg, true);
    next = setWhatsAppDmPolicy(next, "allowlist");
    next = setWhatsAppAllowFrom(next, unique);
    await prompter.note(
      t("channelOnboarding.whatsapp.personalPhoneEnabled", { number: normalized }),
      t("channelOnboarding.whatsapp.personalPhoneLabel"),
    );
    return next;
  }

  const policy = (await prompter.select({
    message: t("channelOnboarding.whatsapp.dmPolicyPrompt"),
    options: [
      { value: "pairing", label: t("channelOnboarding.whatsapp.policyPairing") },
      { value: "allowlist", label: t("channelOnboarding.whatsapp.policyAllowlist") },
      { value: "open", label: t("channelOnboarding.whatsapp.policyOpen") },
      { value: "disabled", label: t("channelOnboarding.whatsapp.policyDisabled") },
    ],
  })) as DmPolicy;

  let next = setWhatsAppSelfChatMode(cfg, false);
  next = setWhatsAppDmPolicy(next, policy);
  if (policy === "open") {
    next = setWhatsAppAllowFrom(next, ["*"]);
  }
  if (policy === "disabled") {
    return next;
  }

  const allowOptions =
    existingAllowFrom.length > 0
      ? ([
          { value: "keep", label: t("channelOnboarding.whatsapp.keepCurrentAllowFrom") },
          {
            value: "unset",
            label: t("channelOnboarding.whatsapp.unsetAllowFromPairing"),
          },
          { value: "list", label: t("channelOnboarding.whatsapp.setSpecificNumbers") },
        ] as const)
      : ([
          { value: "unset", label: t("channelOnboarding.whatsapp.unsetAllowFrom") },
          { value: "list", label: t("channelOnboarding.whatsapp.setSpecificNumbers") },
        ] as const);

  const mode = await prompter.select({
    message: t("channelOnboarding.whatsapp.allowFromPrompt"),
    options: allowOptions.map((opt) => ({
      value: opt.value,
      label: opt.label,
    })),
  });

  if (mode === "keep") {
    // Keep allowFrom as-is.
  } else if (mode === "unset") {
    next = setWhatsAppAllowFrom(next, undefined);
  } else {
    const allowRaw = await prompter.text({
      message: t("channelOnboarding.whatsapp.allowedSendersPrompt"),
      placeholder: t("channelOnboarding.whatsapp.allowedSendersPlaceholder"),
      validate: (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) {
          return t("channelOnboarding.common.required");
        }
        const parts = raw
          .split(/[\n,;]+/g)
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length === 0) {
          return t("channelOnboarding.common.required");
        }
        for (const part of parts) {
          if (part === "*") {
            continue;
          }
          const normalized = normalizeE164(part);
          if (!normalized) {
            return t("channelOnboarding.whatsapp.invalidNumber", { number: part });
          }
        }
        return undefined;
      },
    });

    const parts = String(allowRaw)
      .split(/[\n,;]+/g)
      .map((p) => p.trim())
      .filter(Boolean);
    const normalized = parts.map((part) => (part === "*" ? "*" : normalizeE164(part)));
    const unique = [...new Set(normalized.filter(Boolean))];
    next = setWhatsAppAllowFrom(next, unique);
  }

  return next;
}

export const whatsappOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg, accountOverrides }) => {
    const overrideId = accountOverrides.whatsapp?.trim();
    const defaultAccountId = resolveDefaultWhatsAppAccountId(cfg);
    const accountId = overrideId ? normalizeAccountId(overrideId) : defaultAccountId;
    const linked = await detectWhatsAppLinked(cfg, accountId);
    const accountLabel = accountId === DEFAULT_ACCOUNT_ID ? "default" : accountId;
    return {
      channel,
      configured: linked,
      statusLines: [
        linked
          ? t("channelOnboarding.whatsapp.statusLinked", { account: accountLabel })
          : t("channelOnboarding.whatsapp.statusNotLinked", { account: accountLabel }),
      ],
      selectionHint: linked
        ? t("channelOnboarding.common.linked")
        : t("channelOnboarding.common.notLinked"),
      quickstartScore: linked ? 5 : 4,
    };
  },
  configure: async ({
    cfg,
    runtime,
    prompter,
    options,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const overrideId = accountOverrides.whatsapp?.trim();
    let accountId = overrideId
      ? normalizeAccountId(overrideId)
      : resolveDefaultWhatsAppAccountId(cfg);
    if (shouldPromptAccountIds || options?.promptWhatsAppAccountId) {
      if (!overrideId) {
        accountId = await promptAccountId({
          cfg,
          prompter,
          label: "WhatsApp",
          currentId: accountId,
          listAccountIds: listWhatsAppAccountIds,
          defaultAccountId: resolveDefaultWhatsAppAccountId(cfg),
        });
      }
    }

    let next = cfg;
    if (accountId !== DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          whatsapp: {
            ...next.channels?.whatsapp,
            accounts: {
              ...next.channels?.whatsapp?.accounts,
              [accountId]: {
                ...next.channels?.whatsapp?.accounts?.[accountId],
                enabled: next.channels?.whatsapp?.accounts?.[accountId]?.enabled ?? true,
              },
            },
          },
        },
      };
    }

    const linked = await detectWhatsAppLinked(next, accountId);
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: next,
      accountId,
    });

    if (!linked) {
      await prompter.note(
        t("channelOnboarding.whatsapp.linkingHelp", {
          authDir,
          docsLink: formatDocsLink("/whatsapp", "whatsapp"),
        }),
        t("channelOnboarding.whatsapp.linkingLabel"),
      );
    }
    const wantsLink = await prompter.confirm({
      message: linked
        ? t("channelOnboarding.whatsapp.relinkPrompt")
        : t("channelOnboarding.whatsapp.linkPrompt"),
      initialValue: !linked,
    });
    if (wantsLink) {
      try {
        await loginWeb(false, undefined, runtime, accountId);
      } catch (err) {
        runtime.error(t("channelOnboarding.whatsapp.loginFailed", { error: String(err) }));
        await prompter.note(
          `Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`,
          t("channelOnboarding.whatsapp.helpLabel"),
        );
      }
    } else if (!linked) {
      await prompter.note(
        t("channelOnboarding.whatsapp.runLaterHint", {
          command: formatCliCommand("openclaw channels login"),
        }),
        "WhatsApp",
      );
    }

    next = await promptWhatsAppAllowFrom(next, runtime, prompter, {
      forceAllowlist: forceAllowFrom,
    });

    return { cfg: next, accountId };
  },
  onAccountRecorded: (accountId, options) => {
    options?.onWhatsAppAccountId?.(accountId);
  },
};
