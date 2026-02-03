import type { WizardPrompter } from "../../../wizard/prompts.js";
import { t } from "../../../i18n/index.js";

export type ChannelAccessPolicy = "allowlist" | "open" | "disabled";

export function parseAllowlistEntries(raw: string): string[] {
  return String(raw ?? "")
    .split(/[,\n]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function formatAllowlistEntries(entries: string[]): string {
  return entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(", ");
}

export async function promptChannelAccessPolicy(params: {
  prompter: WizardPrompter;
  label: string;
  currentPolicy?: ChannelAccessPolicy;
  allowOpen?: boolean;
  allowDisabled?: boolean;
}): Promise<ChannelAccessPolicy> {
  const options: Array<{ value: ChannelAccessPolicy; label: string }> = [
    { value: "allowlist", label: t("channelOnboarding.common.allowlistRecommended") },
  ];
  if (params.allowOpen !== false) {
    options.push({ value: "open", label: t("channelOnboarding.common.openAllowAll") });
  }
  if (params.allowDisabled !== false) {
    options.push({ value: "disabled", label: t("channelOnboarding.common.disabledBlockAll") });
  }
  const initialValue = params.currentPolicy ?? "allowlist";
  return await params.prompter.select({
    message: t("channelOnboarding.common.channelAccess", { label: params.label }),
    options,
    initialValue,
  });
}

export async function promptChannelAllowlist(params: {
  prompter: WizardPrompter;
  label: string;
  currentEntries?: string[];
  placeholder?: string;
}): Promise<string[]> {
  const initialValue =
    params.currentEntries && params.currentEntries.length > 0
      ? formatAllowlistEntries(params.currentEntries)
      : undefined;
  const raw = await params.prompter.text({
    message: t("channelOnboarding.common.allowlistCommaSeparated", { label: params.label }),
    placeholder: params.placeholder,
    initialValue,
  });
  return parseAllowlistEntries(raw);
}

export async function promptChannelAccessConfig(params: {
  prompter: WizardPrompter;
  label: string;
  currentPolicy?: ChannelAccessPolicy;
  currentEntries?: string[];
  placeholder?: string;
  allowOpen?: boolean;
  allowDisabled?: boolean;
  defaultPrompt?: boolean;
  updatePrompt?: boolean;
}): Promise<{ policy: ChannelAccessPolicy; entries: string[] } | null> {
  const hasEntries = (params.currentEntries ?? []).length > 0;
  const shouldPrompt = params.defaultPrompt ?? !hasEntries;
  const wants = await params.prompter.confirm({
    message: params.updatePrompt
      ? t("channelOnboarding.common.updateAccess", { label: params.label })
      : t("channelOnboarding.common.configureAccess", { label: params.label }),
    initialValue: shouldPrompt,
  });
  if (!wants) {
    return null;
  }
  const policy = await promptChannelAccessPolicy({
    prompter: params.prompter,
    label: params.label,
    currentPolicy: params.currentPolicy,
    allowOpen: params.allowOpen,
    allowDisabled: params.allowDisabled,
  });
  if (policy !== "allowlist") {
    return { policy, entries: [] };
  }
  const entries = await promptChannelAllowlist({
    prompter: params.prompter,
    label: params.label,
    currentEntries: params.currentEntries,
    placeholder: params.placeholder,
  });
  return { policy, entries };
}
