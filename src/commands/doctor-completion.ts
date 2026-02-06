import { spawnSync } from "node:child_process";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { resolveCliName } from "../cli/cli-name.js";
import {
  completionCacheExists,
  installCompletion,
  isCompletionInstalled,
  resolveCompletionCachePath,
  resolveShellFromEnv,
  usesSlowDynamicCompletion,
} from "../cli/completion-cli.js";
import { t } from "../i18n/index.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { note } from "../terminal/note.js";

type CompletionShell = "zsh" | "bash" | "fish" | "powershell";

/** Generate the completion cache by spawning the CLI. */
async function generateCompletionCache(): Promise<boolean> {
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!root) {
    return false;
  }

  const binPath = path.join(root, "openclaw.mjs");
  const result = spawnSync(process.execPath, [binPath, "completion", "--write-state"], {
    cwd: root,
    env: process.env,
    encoding: "utf-8",
  });

  return result.status === 0;
}

export type ShellCompletionStatus = {
  shell: CompletionShell;
  profileInstalled: boolean;
  cacheExists: boolean;
  cachePath: string;
  /** True if profile uses slow dynamic pattern like `source <(openclaw completion ...)` */
  usesSlowPattern: boolean;
};

/** Check the status of shell completion for the current shell. */
export async function checkShellCompletionStatus(
  binName = "openclaw",
): Promise<ShellCompletionStatus> {
  const shell = resolveShellFromEnv() as CompletionShell;
  const profileInstalled = await isCompletionInstalled(shell, binName);
  const cacheExists = await completionCacheExists(shell, binName);
  const cachePath = resolveCompletionCachePath(shell, binName);
  const usesSlowPattern = await usesSlowDynamicCompletion(shell, binName);

  return {
    shell,
    profileInstalled,
    cacheExists,
    cachePath,
    usesSlowPattern,
  };
}

export type DoctorCompletionOptions = {
  nonInteractive?: boolean;
};

/**
 * Doctor check for shell completion.
 * - If profile uses slow dynamic pattern: upgrade to cached version
 * - If profile has completion but no cache: auto-generate cache and upgrade profile
 * - If no completion at all: prompt to install (with user confirmation)
 */
export async function doctorShellCompletion(
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
  options: DoctorCompletionOptions = {},
): Promise<void> {
  const cliName = resolveCliName();
  const status = await checkShellCompletionStatus(cliName);

  // Profile uses slow dynamic pattern - upgrade to cached version
  if (status.usesSlowPattern) {
    note(
      t(
        "doctor.completion.slowPatternUpgrade",
        { shell: status.shell },
        `Your ${status.shell} profile uses slow dynamic completion (source <(...)).\nUpgrading to cached completion for faster shell startup...`,
      ),
      t("doctor.completion.title", {}, "Shell completion"),
    );

    // Ensure cache exists first
    if (!status.cacheExists) {
      const generated = await generateCompletionCache();
      if (!generated) {
        note(
          t(
            "doctor.completion.generateFailed",
            { cliName },
            `Failed to generate completion cache. Run \`${cliName} completion --write-state\` manually.`,
          ),
          t("doctor.completion.title", {}, "Shell completion"),
        );
        return;
      }
    }

    // Upgrade profile to use cached file
    await installCompletion(status.shell, true, cliName);
    const profileFile =
      status.shell === "zsh"
        ? "zshrc"
        : status.shell === "bash"
          ? "bashrc"
          : "config/fish/config.fish";
    note(
      t(
        "doctor.completion.upgraded",
        { profileFile },
        `Shell completion upgraded. Restart your shell or run: source ~/.${profileFile}`,
      ),
      t("doctor.completion.title", {}, "Shell completion"),
    );
    return;
  }

  // Profile has completion but no cache - auto-fix
  if (status.profileInstalled && !status.cacheExists) {
    note(
      t(
        "doctor.completion.cacheMissing",
        { shell: status.shell },
        `Shell completion is configured in your ${status.shell} profile but the cache is missing.\nRegenerating cache...`,
      ),
      t("doctor.completion.title", {}, "Shell completion"),
    );
    const generated = await generateCompletionCache();
    if (generated) {
      note(
        t(
          "doctor.completion.cacheRegenerated",
          { cachePath: status.cachePath },
          `Completion cache regenerated at ${status.cachePath}`,
        ),
        t("doctor.completion.title", {}, "Shell completion"),
      );
    } else {
      note(
        t(
          "doctor.completion.generateFailed",
          { cliName },
          `Failed to regenerate completion cache. Run \`${cliName} completion --write-state\` manually.`,
        ),
        t("doctor.completion.title", {}, "Shell completion"),
      );
    }
    return;
  }

  // No completion at all - prompt to install
  if (!status.profileInstalled) {
    if (options.nonInteractive) {
      // In non-interactive mode, just note that completion is not installed
      return;
    }

    const shouldInstall = await prompter.confirm({
      message: t(
        "doctor.completion.enablePrompt",
        { shell: status.shell, cliName },
        `Enable ${status.shell} shell completion for ${cliName}?`,
      ),
      initialValue: true,
    });

    if (shouldInstall) {
      // First generate the cache
      const generated = await generateCompletionCache();
      if (!generated) {
        note(
          t(
            "doctor.completion.generateFailed",
            { cliName },
            `Failed to generate completion cache. Run \`${cliName} completion --write-state\` manually.`,
          ),
          t("doctor.completion.title", {}, "Shell completion"),
        );
        return;
      }

      // Then install to profile
      await installCompletion(status.shell, true, cliName);
      const profileFile =
        status.shell === "zsh"
          ? "zshrc"
          : status.shell === "bash"
            ? "bashrc"
            : "config/fish/config.fish";
      note(
        t(
          "doctor.completion.installed",
          { profileFile },
          `Shell completion installed. Restart your shell or run: source ~/.${profileFile}`,
        ),
        t("doctor.completion.title", {}, "Shell completion"),
      );
    }
  }
}

/**
 * Ensure completion cache exists. Used during onboarding/update to fix
 * cases where profile has completion but no cache.
 * This is a silent fix - no prompts.
 */
export async function ensureCompletionCacheExists(binName = "openclaw"): Promise<boolean> {
  const shell = resolveShellFromEnv() as CompletionShell;
  const cacheExists = await completionCacheExists(shell, binName);

  if (cacheExists) {
    return true;
  }

  return generateCompletionCache();
}
