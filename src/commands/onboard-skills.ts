import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { installSkill } from "../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { formatCliCommand } from "../cli/command-format.js";
import { t } from "../i18n/index.js";
import { detectBinary, resolveNodeManagerOptions } from "./onboard-helpers.js";

function summarizeInstallFailure(message: string): string | undefined {
  const cleaned = message.replace(/^Install failed(?:\s*\([^)]*\))?\s*:?\s*/i, "").trim();
  if (!cleaned) {
    return undefined;
  }
  const maxLen = 140;
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function formatSkillHint(skill: {
  description?: string;
  install: Array<{ label: string }>;
}): string {
  const desc = skill.description?.trim();
  const installLabel = skill.install[0]?.label?.trim();
  const combined = desc && installLabel ? `${desc} — ${installLabel}` : desc || installLabel;
  if (!combined) {
    return "install";
  }
  const maxLen = 90;
  return combined.length > maxLen ? `${combined.slice(0, maxLen - 1)}…` : combined;
}

function upsertSkillEntry(
  cfg: OpenClawConfig,
  skillKey: string,
  patch: { apiKey?: string },
): OpenClawConfig {
  const entries = { ...cfg.skills?.entries };
  const existing = (entries[skillKey] as { apiKey?: string } | undefined) ?? {};
  entries[skillKey] = { ...existing, ...patch };
  return {
    ...cfg,
    skills: {
      ...cfg.skills,
      entries,
    },
  };
}

export async function setupSkills(
  cfg: OpenClawConfig,
  workspaceDir: string,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const report = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  const eligible = report.skills.filter((s) => s.eligible);
  const missing = report.skills.filter((s) => !s.eligible && !s.disabled && !s.blockedByAllowlist);
  const blocked = report.skills.filter((s) => s.blockedByAllowlist);

  const needsBrewPrompt =
    process.platform !== "win32" &&
    report.skills.some((skill) => skill.install.some((option) => option.kind === "brew")) &&
    !(await detectBinary("brew"));

  await prompter.note(
    [
      t("onboard.skills.eligible", { count: eligible.length }, `Eligible: ${eligible.length}`),
      t(
        "onboard.skills.missingRequirements",
        { count: missing.length },
        `Missing requirements: ${missing.length}`,
      ),
      t(
        "onboard.skills.blockedByAllowlist",
        { count: blocked.length },
        `Blocked by allowlist: ${blocked.length}`,
      ),
    ].join("\n"),
    t("onboard.skills.statusLabel", {}, "Skills status"),
  );

  const shouldConfigure = await prompter.confirm({
    message: t("onboard.skills.configureNow", {}, "Configure skills now? (recommended)"),
    initialValue: true,
  });
  if (!shouldConfigure) {
    return cfg;
  }

  if (needsBrewPrompt) {
    await prompter.note(
      t(
        "onboard.skills.brewRecommended",
        {},
        "Many skill dependencies are shipped via Homebrew.\nWithout brew, you'll need to build from source or download releases manually.",
      ),
      t("onboard.skills.brewRecommendedLabel", {}, "Homebrew recommended"),
    );
    const showBrewInstall = await prompter.confirm({
      message: t("onboard.skills.brewShowInstall", {}, "Show Homebrew install command?"),
      initialValue: true,
    });
    if (showBrewInstall) {
      await prompter.note(
        t(
          "onboard.skills.brewInstallCommand",
          {},
          'Run:\n/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        ),
        t("onboard.skills.brewInstallLabel", {}, "Homebrew install"),
      );
    }
  }

  const nodeManager = (await prompter.select({
    message: t("onboard.skills.nodeManagerPrompt", {}, "Preferred node manager for skill installs"),
    options: resolveNodeManagerOptions(),
  })) as "npm" | "pnpm" | "bun";

  let next: OpenClawConfig = {
    ...cfg,
    skills: {
      ...cfg.skills,
      install: {
        ...cfg.skills?.install,
        nodeManager,
      },
    },
  };

  const installable = missing.filter(
    (skill) => skill.install.length > 0 && skill.missing.bins.length > 0,
  );
  if (installable.length > 0) {
    const toInstall = await prompter.multiselect({
      message: t("onboard.skills.installMissing", {}, "Install missing skill dependencies"),
      options: [
        {
          value: "__skip__",
          label: t("onboard.skills.skipForNow", {}, "Skip for now"),
          hint: t("onboard.skills.skipHint", {}, "Continue without installing dependencies"),
        },
        ...installable.map((skill) => ({
          value: skill.name,
          label: `${skill.emoji ?? "🧩"} ${skill.name}`,
          hint: formatSkillHint(skill),
        })),
      ],
    });

    const selected = toInstall.filter((name) => name !== "__skip__");
    for (const name of selected) {
      const target = installable.find((s) => s.name === name);
      if (!target || target.install.length === 0) {
        continue;
      }
      const installId = target.install[0]?.id;
      if (!installId) {
        continue;
      }
      const spin = prompter.progress(
        t("onboard.skills.installing", { name }, `Installing ${name}…`),
      );
      const result = await installSkill({
        workspaceDir,
        skillName: target.name,
        installId,
        config: next,
      });
      const warnings = result.warnings ?? [];
      if (result.ok) {
        spin.stop(
          warnings.length > 0
            ? t(
                "onboard.skills.installedWithWarnings",
                { name },
                `Installed ${name} (with warnings)`,
              )
            : t("onboard.skills.installed", { name }, `Installed ${name}`),
        );
        for (const warning of warnings) {
          runtime.log(warning);
        }
        continue;
      }
      const code = result.code == null ? "" : ` (exit ${result.code})`;
      const detail = summarizeInstallFailure(result.message);
      spin.stop(
        detail
          ? t(
              "onboard.skills.installFailedDetail",
              { name, code, detail },
              `Install failed: ${name}${code} — ${detail}`,
            )
          : t("onboard.skills.installFailed", { name, code }, `Install failed: ${name}${code}`),
      );
      for (const warning of warnings) {
        runtime.log(warning);
      }
      if (result.stderr) {
        runtime.log(result.stderr.trim());
      } else if (result.stdout) {
        runtime.log(result.stdout.trim());
      }
      runtime.log(
        t(
          "onboard.skills.doctorTip",
          { command: formatCliCommand("openclaw doctor") },
          `Tip: run \`${formatCliCommand("openclaw doctor")}\` to review skills + requirements.`,
        ),
      );
      runtime.log(t("onboard.skills.docsLink", {}, "Docs: https://docs.openclaw.ai/skills"));
    }
  }

  for (const skill of missing) {
    if (!skill.primaryEnv || skill.missing.env.length === 0) {
      continue;
    }
    const wantsKey = await prompter.confirm({
      message: t(
        "onboard.skills.setEnvVar",
        { envVar: skill.primaryEnv, name: skill.name },
        `Set ${skill.primaryEnv} for ${skill.name}?`,
      ),
      initialValue: false,
    });
    if (!wantsKey) {
      continue;
    }
    const apiKey = String(
      await prompter.text({
        message: t(
          "onboard.skills.enterEnvVar",
          { envVar: skill.primaryEnv },
          `Enter ${skill.primaryEnv}`,
        ),
        validate: (value) =>
          value?.trim() ? undefined : t("onboard.skills.required", {}, "Required"),
      }),
    );
    next = upsertSkillEntry(next, skill.skillKey, { apiKey: apiKey.trim() });
  }

  return next;
}
