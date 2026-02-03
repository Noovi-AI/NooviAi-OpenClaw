import type { PromptAccountId, PromptAccountIdParams } from "../onboarding-types.js";
import { t } from "../../../i18n/index.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";

export const promptAccountId: PromptAccountId = async (params: PromptAccountIdParams) => {
  const existingIds = params.listAccountIds(params.cfg);
  const initial = params.currentId?.trim() || params.defaultAccountId || DEFAULT_ACCOUNT_ID;
  const choice = await params.prompter.select({
    message: t("channelOnboarding.common.accountLabel", { label: params.label }),
    options: [
      ...existingIds.map((id) => ({
        value: id,
        label: id === DEFAULT_ACCOUNT_ID ? t("channelOnboarding.common.defaultPrimary") : id,
      })),
      { value: "__new__", label: t("channelOnboarding.common.addNewAccount") },
    ],
    initialValue: initial,
  });

  if (choice !== "__new__") {
    return normalizeAccountId(choice);
  }

  const entered = await params.prompter.text({
    message: t("channelOnboarding.common.newAccountId", { label: params.label }),
    validate: (value) => (value?.trim() ? undefined : t("channelOnboarding.common.required")),
  });
  const normalized = normalizeAccountId(String(entered));
  if (String(entered).trim() !== normalized) {
    await params.prompter.note(
      t("channelOnboarding.common.normalizedAccountId", { normalized }),
      t("channelOnboarding.common.accountLabel", { label: params.label }),
    );
  }
  return normalized;
};

export function addWildcardAllowFrom(
  allowFrom?: Array<string | number> | null,
): Array<string | number> {
  const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (!next.includes("*")) {
    next.push("*");
  }
  return next;
}
