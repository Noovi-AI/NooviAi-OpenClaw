import type { Command } from "commander";
import { confirm, isCancel, select, spinner } from "@clack/prompts";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../commands/doctor-completion.js";
import { doctorCommand } from "../commands/doctor.js";
import {
  formatUpdateAvailableHint,
  formatUpdateOneLiner,
  resolveUpdateAvailability,
} from "../commands/status.update.js";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { t } from "../i18n/index.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { trimLogTail } from "../infra/restart-sentinel.js";
import { parseSemver } from "../infra/runtime-guard.js";
import {
  channelToNpmTag,
  DEFAULT_GIT_CHANNEL,
  DEFAULT_PACKAGE_CHANNEL,
  formatUpdateChannelLabel,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../infra/update-channels.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  fetchNpmTagVersion,
  resolveNpmChannelTag,
} from "../infra/update-check.js";
import {
  detectGlobalInstallManagerByPresence,
  detectGlobalInstallManagerForRoot,
  cleanupGlobalRenameDirs,
  globalInstallArgs,
  resolveGlobalPackageRoot,
  type GlobalInstallManager,
} from "../infra/update-global.js";
import {
  runGatewayUpdate,
  type UpdateRunResult,
  type UpdateStepInfo,
  type UpdateStepResult,
  type UpdateStepProgress,
} from "../infra/update-runner.js";
import { syncPluginsForUpdateChannel, updateNpmInstalledPlugins } from "../plugins/update.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { stylePromptHint, stylePromptMessage } from "../terminal/prompt-style.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { replaceCliName, resolveCliName } from "./cli-name.js";
import { formatCliCommand } from "./command-format.js";
import { installCompletion } from "./completion-cli.js";
import { runDaemonRestart } from "./daemon-cli.js";
import { formatHelpExamples } from "./help-format.js";

export type UpdateCommandOptions = {
  json?: boolean;
  restart?: boolean;
  channel?: string;
  tag?: string;
  timeout?: string;
  yes?: boolean;
};
export type UpdateStatusOptions = {
  json?: boolean;
  timeout?: string;
};
export type UpdateWizardOptions = {
  timeout?: string;
};

const STEP_LABELS: Record<string, string> = {
  "clean check": t("update.steps.cleanCheck", {}, "Working directory is clean"),
  "upstream check": t("update.steps.upstreamCheck", {}, "Upstream branch exists"),
  "git fetch": t("update.steps.gitFetch", {}, "Fetching latest changes"),
  "git rebase": t("update.steps.gitRebase", {}, "Rebasing onto target commit"),
  "git rev-parse @{upstream}": t("update.steps.resolveUpstream", {}, "Resolving upstream commit"),
  "git rev-list": t("update.steps.enumCommits", {}, "Enumerating candidate commits"),
  "git clone": t("update.steps.gitClone", {}, "Cloning git checkout"),
  "preflight worktree": t("update.steps.preflightWorktree", {}, "Preparing preflight worktree"),
  "preflight cleanup": t("update.steps.preflightCleanup", {}, "Cleaning preflight worktree"),
  "deps install": t("update.steps.depsInstall", {}, "Installing dependencies"),
  build: t("update.steps.build", {}, "Building"),
  "ui:build": t("update.steps.uiBuild", {}, "Building UI assets"),
  "ui:build (post-doctor repair)": t(
    "update.steps.uiBuildRepair",
    {},
    "Restoring missing UI assets",
  ),
  "ui assets verify": t("update.steps.uiAssetsVerify", {}, "Validating UI assets"),
  "openclaw doctor entry": t("update.steps.doctorEntry", {}, "Checking doctor entrypoint"),
  "openclaw doctor": t("update.steps.doctorRun", {}, "Running doctor checks"),
  "git rev-parse HEAD (after)": t("update.steps.verifyUpdate", {}, "Verifying update"),
  "global update": t("update.steps.globalUpdate", {}, "Updating via package manager"),
  "global install": t("update.steps.globalInstall", {}, "Installing global package"),
};

const UPDATE_QUIPS = [
  t("update.quip1", {}, "Leveled up! New skills unlocked. You're welcome."),
  t("update.quip2", {}, "Fresh code, same lobster. Miss me?"),
  t("update.quip3", {}, "Back and better. Did you even notice I was gone?"),
  t("update.quip4", {}, "Update complete. I learned some new tricks while I was out."),
  t("update.quip5", {}, "Upgraded! Now with 23% more sass."),
  t("update.quip6", {}, "I've evolved. Try to keep up."),
  t("update.quip7", {}, "New version, who dis? Oh right, still me but shinier."),
  t("update.quip8", {}, "Patched, polished, and ready to pinch. Let's go."),
  t("update.quip9", {}, "The lobster has molted. Harder shell, sharper claws."),
  t("update.quip10", {}, "Update done! Check the changelog or just trust me, it's good."),
  t("update.quip11", {}, "Reborn from the boiling waters of npm. Stronger now."),
  t("update.quip12", {}, "I went away and came back smarter. You should try it sometime."),
  t("update.quip13", {}, "Update complete. The bugs feared me, so they left."),
  t("update.quip14", {}, "New version installed. Old version sends its regards."),
  t("update.quip15", {}, "Firmware fresh. Brain wrinkles: increased."),
  t("update.quip16", {}, "I've seen things you wouldn't believe. Anyway, I'm updated."),
  t("update.quip17", {}, "Back online. The changelog is long but our friendship is longer."),
  t("update.quip18", {}, "Upgraded! Peter fixed stuff. Blame him if it breaks."),
  t("update.quip19", {}, "Molting complete. Please don't look at my soft shell phase."),
  t("update.quip20", {}, "Version bump! Same chaos energy, fewer crashes (probably)."),
];

const MAX_LOG_CHARS = 8000;
const DEFAULT_PACKAGE_NAME = "openclaw";
const CORE_PACKAGE_NAMES = new Set([DEFAULT_PACKAGE_NAME]);
const CLI_NAME = resolveCliName();
const OPENCLAW_REPO_URL = "https://github.com/openclaw/openclaw.git";
const DEFAULT_GIT_DIR = path.join(os.homedir(), ".openclaw");

function normalizeTag(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("openclaw@")) {
    return trimmed.slice("openclaw@".length);
  }
  if (trimmed.startsWith(`${DEFAULT_PACKAGE_NAME}@`)) {
    return trimmed.slice(`${DEFAULT_PACKAGE_NAME}@`.length);
  }
  return trimmed;
}

function pickUpdateQuip(): string {
  return (
    UPDATE_QUIPS[Math.floor(Math.random() * UPDATE_QUIPS.length)] ??
    t("update.complete", {}, "Update complete.")
  );
}

function normalizeVersionTag(tag: string): string | null {
  const trimmed = tag.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  return parseSemver(cleaned) ? cleaned : null;
}

async function readPackageVersion(root: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

async function resolveTargetVersion(tag: string, timeoutMs?: number): Promise<string | null> {
  const direct = normalizeVersionTag(tag);
  if (direct) {
    return direct;
  }
  const res = await fetchNpmTagVersion({ tag, timeoutMs });
  return res.version ?? null;
}

async function isGitCheckout(root: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function readPackageName(root: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { name?: string };
    const name = parsed?.name?.trim();
    return name ? name : null;
  } catch {
    return null;
  }
}

async function isCorePackage(root: string): Promise<boolean> {
  const name = await readPackageName(root);
  return Boolean(name && CORE_PACKAGE_NAMES.has(name));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function tryWriteCompletionCache(root: string, jsonMode: boolean): Promise<void> {
  const binPath = path.join(root, "openclaw.mjs");
  if (!(await pathExists(binPath))) {
    return;
  }
  const result = spawnSync(resolveNodeRunner(), [binPath, "completion", "--write-state"], {
    cwd: root,
    env: process.env,
    encoding: "utf-8",
  });
  if (result.error) {
    if (!jsonMode) {
      defaultRuntime.log(
        theme.warn(
          t(
            "update.completionCacheFailed",
            { error: String(result.error) },
            `Completion cache update failed: ${String(result.error)}`,
          ),
        ),
      );
    }
    return;
  }
  if (result.status !== 0 && !jsonMode) {
    const stderr = (result.stderr ?? "").toString().trim();
    const detail = stderr ? ` (${stderr})` : "";
    defaultRuntime.log(
      theme.warn(
        t(
          "update.completionCacheFailedDetail",
          { detail },
          `Completion cache update failed${detail}.`,
        ),
      ),
    );
  }
}

/** Check if shell completion is installed and prompt user to install if not. */
async function tryInstallShellCompletion(opts: {
  jsonMode: boolean;
  skipPrompt: boolean;
}): Promise<void> {
  if (opts.jsonMode || !process.stdin.isTTY) {
    return;
  }

  const status = await checkShellCompletionStatus(CLI_NAME);

  // Profile uses slow dynamic pattern - upgrade to cached version
  if (status.usesSlowPattern) {
    defaultRuntime.log(
      theme.muted(
        t("update.upgradingCompletion", {}, "Upgrading shell completion to cached version..."),
      ),
    );
    // Ensure cache exists first
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (cacheGenerated) {
      await installCompletion(status.shell, true, CLI_NAME);
    }
    return;
  }

  // Profile has completion but no cache - auto-fix silently
  if (status.profileInstalled && !status.cacheExists) {
    defaultRuntime.log(
      theme.muted(
        t("update.regeneratingCompletionCache", {}, "Regenerating shell completion cache..."),
      ),
    );
    await ensureCompletionCacheExists(CLI_NAME);
    return;
  }

  // No completion at all - prompt to install
  if (!status.profileInstalled) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading(t("update.shellCompletionHeading", {}, "Shell completion")));

    const shouldInstall = await confirm({
      message: stylePromptMessage(
        t(
          "update.enableShellCompletion",
          { shell: status.shell, cliName: CLI_NAME },
          `Enable ${status.shell} shell completion for ${CLI_NAME}?`,
        ),
      ),
      initialValue: true,
    });

    if (isCancel(shouldInstall) || !shouldInstall) {
      if (!opts.skipPrompt) {
        defaultRuntime.log(
          theme.muted(
            t(
              "update.shellCompletionSkipped",
              {
                command: replaceCliName(
                  formatCliCommand("openclaw completion --install"),
                  CLI_NAME,
                ),
              },
              `Skipped. Run \`${replaceCliName(formatCliCommand("openclaw completion --install"), CLI_NAME)}\` later to enable.`,
            ),
          ),
        );
      }
      return;
    }

    // Generate cache first (required for fast shell startup)
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (!cacheGenerated) {
      defaultRuntime.log(
        theme.warn(
          t("update.completionCacheGenerateFailed", {}, "Failed to generate completion cache."),
        ),
      );
      return;
    }

    await installCompletion(status.shell, opts.skipPrompt, CLI_NAME);
  }
}

async function isEmptyDir(targetPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(targetPath);
    return entries.length === 0;
  } catch {
    return false;
  }
}

function resolveGitInstallDir(): string {
  const override = process.env.OPENCLAW_GIT_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return resolveDefaultGitDir();
}

function resolveDefaultGitDir(): string {
  return DEFAULT_GIT_DIR;
}

function resolveNodeRunner(): string {
  const base = path.basename(process.execPath).toLowerCase();
  if (base === "node" || base === "node.exe") {
    return process.execPath;
  }
  return "node";
}

async function runUpdateStep(params: {
  name: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  progress?: UpdateStepProgress;
}): Promise<UpdateStepResult> {
  const command = params.argv.join(" ");
  params.progress?.onStepStart?.({
    name: params.name,
    command,
    index: 0,
    total: 0,
  });
  const started = Date.now();
  const res = await runCommandWithTimeout(params.argv, {
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
  });
  const durationMs = Date.now() - started;
  const stderrTail = trimLogTail(res.stderr, MAX_LOG_CHARS);
  params.progress?.onStepComplete?.({
    name: params.name,
    command,
    index: 0,
    total: 0,
    durationMs,
    exitCode: res.code,
    stderrTail,
  });
  return {
    name: params.name,
    command,
    cwd: params.cwd ?? process.cwd(),
    durationMs,
    exitCode: res.code,
    stdoutTail: trimLogTail(res.stdout, MAX_LOG_CHARS),
    stderrTail,
  };
}

async function ensureGitCheckout(params: {
  dir: string;
  timeoutMs: number;
  progress?: UpdateStepProgress;
}): Promise<UpdateStepResult | null> {
  const dirExists = await pathExists(params.dir);
  if (!dirExists) {
    return await runUpdateStep({
      name: "git clone",
      argv: ["git", "clone", OPENCLAW_REPO_URL, params.dir],
      timeoutMs: params.timeoutMs,
      progress: params.progress,
    });
  }

  if (!(await isGitCheckout(params.dir))) {
    const empty = await isEmptyDir(params.dir);
    if (!empty) {
      throw new Error(
        t(
          "update.nonGitDirectory",
          { dir: params.dir },
          `OPENCLAW_GIT_DIR points at a non-git directory: ${params.dir}. Set OPENCLAW_GIT_DIR to an empty folder or an openclaw checkout.`,
        ),
      );
    }
    return await runUpdateStep({
      name: "git clone",
      argv: ["git", "clone", OPENCLAW_REPO_URL, params.dir],
      cwd: params.dir,
      timeoutMs: params.timeoutMs,
      progress: params.progress,
    });
  }

  if (!(await isCorePackage(params.dir))) {
    throw new Error(
      t(
        "update.notCoreCheckout",
        { dir: params.dir },
        `OPENCLAW_GIT_DIR does not look like a core checkout: ${params.dir}.`,
      ),
    );
  }

  return null;
}

async function resolveGlobalManager(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  timeoutMs: number;
}): Promise<GlobalInstallManager> {
  const runCommand = async (argv: string[], options: { timeoutMs: number }) => {
    const res = await runCommandWithTimeout(argv, options);
    return { stdout: res.stdout, stderr: res.stderr, code: res.code };
  };
  if (params.installKind === "package") {
    const detected = await detectGlobalInstallManagerForRoot(
      runCommand,
      params.root,
      params.timeoutMs,
    );
    if (detected) {
      return detected;
    }
  }
  const byPresence = await detectGlobalInstallManagerByPresence(runCommand, params.timeoutMs);
  return byPresence ?? "npm";
}

function formatGitStatusLine(params: {
  branch: string | null;
  tag: string | null;
  sha: string | null;
}): string {
  const shortSha = params.sha ? params.sha.slice(0, 8) : null;
  const branch = params.branch && params.branch !== "HEAD" ? params.branch : null;
  const tag = params.tag;
  const parts = [
    branch ?? (tag ? "detached" : "git"),
    tag ? `tag ${tag}` : null,
    shortSha ? `@ ${shortSha}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export async function updateStatusCommand(opts: UpdateStatusOptions): Promise<void> {
  const timeoutMs = opts.timeout ? Number.parseInt(opts.timeout, 10) * 1000 : undefined;
  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
    defaultRuntime.error(
      t("update.timeoutInvalid", {}, "--timeout must be a positive integer (seconds)"),
    );
    defaultRuntime.exit(1);
    return;
  }

  const root =
    (await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd();
  const configSnapshot = await readConfigFileSnapshot();
  const configChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;

  const update = await checkUpdateStatus({
    root,
    timeoutMs: timeoutMs ?? 3500,
    fetchGit: true,
    includeRegistry: true,
  });
  const channelInfo = resolveEffectiveUpdateChannel({
    configChannel,
    installKind: update.installKind,
    git: update.git ? { tag: update.git.tag, branch: update.git.branch } : undefined,
  });
  const channelLabel = formatUpdateChannelLabel({
    channel: channelInfo.channel,
    source: channelInfo.source,
    gitTag: update.git?.tag ?? null,
    gitBranch: update.git?.branch ?? null,
  });
  const gitLabel =
    update.installKind === "git"
      ? formatGitStatusLine({
          branch: update.git?.branch ?? null,
          tag: update.git?.tag ?? null,
          sha: update.git?.sha ?? null,
        })
      : null;
  const updateAvailability = resolveUpdateAvailability(update);
  const updateLine = formatUpdateOneLiner(update).replace(/^Update:\s*/i, "");

  if (opts.json) {
    defaultRuntime.log(
      JSON.stringify(
        {
          update,
          channel: {
            value: channelInfo.channel,
            source: channelInfo.source,
            label: channelLabel,
            config: configChannel,
          },
          availability: updateAvailability,
        },
        null,
        2,
      ),
    );
    return;
  }

  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
  const installLabel =
    update.installKind === "git"
      ? `git (${update.root ?? "unknown"})`
      : update.installKind === "package"
        ? update.packageManager
        : "unknown";
  const rows = [
    { Item: t("update.statusItemInstall", {}, "Install"), Value: installLabel },
    { Item: t("update.statusItemChannel", {}, "Channel"), Value: channelLabel },
    ...(gitLabel ? [{ Item: t("update.statusItemGit", {}, "Git"), Value: gitLabel }] : []),
    {
      Item: t("update.statusItemUpdate", {}, "Update"),
      Value: updateAvailability.available
        ? theme.warn(`${t("update.available", {}, "available")} · ${updateLine}`)
        : updateLine,
    },
  ];

  defaultRuntime.log(theme.heading(t("update.statusHeading", {}, "OpenClaw update status")));
  defaultRuntime.log("");
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Item", header: t("update.tableHeaderItem", {}, "Item"), minWidth: 10 },
        {
          key: "Value",
          header: t("update.tableHeaderValue", {}, "Value"),
          flex: true,
          minWidth: 24,
        },
      ],
      rows,
    }).trimEnd(),
  );
  defaultRuntime.log("");
  const updateHint = formatUpdateAvailableHint(update);
  if (updateHint) {
    defaultRuntime.log(theme.warn(updateHint));
  }
}

function getStepLabel(step: UpdateStepInfo): string {
  return STEP_LABELS[step.name] ?? step.name;
}

type ProgressController = {
  progress: UpdateStepProgress;
  stop: () => void;
};

function createUpdateProgress(enabled: boolean): ProgressController {
  if (!enabled) {
    return {
      progress: {},
      stop: () => {},
    };
  }

  let currentSpinner: ReturnType<typeof spinner> | null = null;

  const progress: UpdateStepProgress = {
    onStepStart: (step) => {
      currentSpinner = spinner();
      currentSpinner.start(theme.accent(getStepLabel(step)));
    },
    onStepComplete: (step) => {
      if (!currentSpinner) {
        return;
      }

      const label = getStepLabel(step);
      const duration = theme.muted(`(${formatDuration(step.durationMs)})`);
      const icon = step.exitCode === 0 ? theme.success("\u2713") : theme.error("\u2717");

      currentSpinner.stop(`${icon} ${label} ${duration}`);
      currentSpinner = null;

      if (step.exitCode !== 0 && step.stderrTail) {
        const lines = step.stderrTail.split("\n").slice(-10);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`    ${theme.error(line)}`);
          }
        }
      }
    },
  };

  return {
    progress,
    stop: () => {
      if (currentSpinner) {
        currentSpinner.stop();
        currentSpinner = null;
      }
    },
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = (ms / 1000).toFixed(1);
  return `${seconds}s`;
}

function formatStepStatus(exitCode: number | null): string {
  if (exitCode === 0) {
    return theme.success("\u2713");
  }
  if (exitCode === null) {
    return theme.warn("?");
  }
  return theme.error("\u2717");
}

const selectStyled = <T>(params: Parameters<typeof select<T>>[0]) =>
  select({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });

type PrintResultOptions = UpdateCommandOptions & {
  hideSteps?: boolean;
};

function printResult(result: UpdateRunResult, opts: PrintResultOptions) {
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
    return;
  }

  const statusColor =
    result.status === "ok" ? theme.success : result.status === "skipped" ? theme.warn : theme.error;

  defaultRuntime.log("");
  defaultRuntime.log(
    `${theme.heading(t("update.resultHeading", {}, "Update Result:"))} ${statusColor(result.status.toUpperCase())}`,
  );
  if (result.root) {
    defaultRuntime.log(`  ${t("update.resultRoot", {}, "Root")}: ${theme.muted(result.root)}`);
  }
  if (result.reason) {
    defaultRuntime.log(
      `  ${t("update.resultReason", {}, "Reason")}: ${theme.muted(result.reason)}`,
    );
  }

  if (result.before?.version || result.before?.sha) {
    const before = result.before.version ?? result.before.sha?.slice(0, 8) ?? "";
    defaultRuntime.log(`  ${t("update.resultBefore", {}, "Before")}: ${theme.muted(before)}`);
  }
  if (result.after?.version || result.after?.sha) {
    const after = result.after.version ?? result.after.sha?.slice(0, 8) ?? "";
    defaultRuntime.log(`  ${t("update.resultAfter", {}, "After")}: ${theme.muted(after)}`);
  }

  if (!opts.hideSteps && result.steps.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading(t("update.stepsHeading", {}, "Steps:")));
    for (const step of result.steps) {
      const status = formatStepStatus(step.exitCode);
      const duration = theme.muted(`(${formatDuration(step.durationMs)})`);
      defaultRuntime.log(`  ${status} ${step.name} ${duration}`);

      if (step.exitCode !== 0 && step.stderrTail) {
        const lines = step.stderrTail.split("\n").slice(0, 5);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`      ${theme.error(line)}`);
          }
        }
      }
    }
  }

  defaultRuntime.log("");
  defaultRuntime.log(
    `${t("update.totalTime", {}, "Total time")}: ${theme.muted(formatDuration(result.durationMs))}`,
  );
}

export async function updateCommand(opts: UpdateCommandOptions): Promise<void> {
  process.noDeprecation = true;
  process.env.NODE_NO_WARNINGS = "1";
  const timeoutMs = opts.timeout ? Number.parseInt(opts.timeout, 10) * 1000 : undefined;
  const shouldRestart = opts.restart !== false;

  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
    defaultRuntime.error(
      t("update.timeoutInvalid", {}, "--timeout must be a positive integer (seconds)"),
    );
    defaultRuntime.exit(1);
    return;
  }

  const root =
    (await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd();

  const updateStatus = await checkUpdateStatus({
    root,
    timeoutMs: timeoutMs ?? 3500,
    fetchGit: false,
    includeRegistry: false,
  });

  const configSnapshot = await readConfigFileSnapshot();
  let activeConfig = configSnapshot.valid ? configSnapshot.config : null;
  const storedChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;

  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel && !requestedChannel) {
    defaultRuntime.error(
      t(
        "update.channelInvalid",
        { channel: opts.channel },
        `--channel must be "stable", "beta", or "dev" (got "${opts.channel}")`,
      ),
    );
    defaultRuntime.exit(1);
    return;
  }
  if (opts.channel && !configSnapshot.valid) {
    const issues = configSnapshot.issues.map((issue) => `- ${issue.path}: ${issue.message}`);
    defaultRuntime.error(
      [
        t(
          "update.configInvalidCannotSetChannel",
          {},
          "Config is invalid; cannot set update channel.",
        ),
        ...issues,
      ].join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }

  const installKind = updateStatus.installKind;
  const switchToGit = requestedChannel === "dev" && installKind !== "git";
  const switchToPackage =
    requestedChannel !== null && requestedChannel !== "dev" && installKind === "git";
  const updateInstallKind = switchToGit ? "git" : switchToPackage ? "package" : installKind;
  const defaultChannel =
    updateInstallKind === "git" ? DEFAULT_GIT_CHANNEL : DEFAULT_PACKAGE_CHANNEL;
  const channel = requestedChannel ?? storedChannel ?? defaultChannel;
  const explicitTag = normalizeTag(opts.tag);
  let tag = explicitTag ?? channelToNpmTag(channel);
  if (updateInstallKind !== "git") {
    const currentVersion = switchToPackage ? null : await readPackageVersion(root);
    let fallbackToLatest = false;
    const targetVersion = explicitTag
      ? await resolveTargetVersion(tag, timeoutMs)
      : await resolveNpmChannelTag({ channel, timeoutMs }).then((resolved) => {
          tag = resolved.tag;
          fallbackToLatest = channel === "beta" && resolved.tag === "latest";
          return resolved.version;
        });
    const cmp =
      currentVersion && targetVersion ? compareSemverStrings(currentVersion, targetVersion) : null;
    const needsConfirm =
      !fallbackToLatest &&
      currentVersion != null &&
      (targetVersion == null || (cmp != null && cmp > 0));

    if (needsConfirm && !opts.yes) {
      if (!process.stdin.isTTY || opts.json) {
        defaultRuntime.error(
          [
            t("update.downgradeConfirmRequired", {}, "Downgrade confirmation required."),
            t(
              "update.downgradeRerunTty",
              {},
              "Downgrading can break configuration. Re-run in a TTY to confirm.",
            ),
          ].join("\n"),
        );
        defaultRuntime.exit(1);
        return;
      }

      const targetLabel = targetVersion ?? `${tag} (${t("update.unknown", {}, "unknown")})`;
      const message = t(
        "update.downgradeConfirmMessage",
        { from: currentVersion, to: targetLabel },
        `Downgrading from ${currentVersion} to ${targetLabel} can break configuration. Continue?`,
      );
      const ok = await confirm({
        message: stylePromptMessage(message),
        initialValue: false,
      });
      if (isCancel(ok) || !ok) {
        if (!opts.json) {
          defaultRuntime.log(theme.muted(t("update.cancelled", {}, "Update cancelled.")));
        }
        defaultRuntime.exit(0);
        return;
      }
    }
  } else if (opts.tag && !opts.json) {
    defaultRuntime.log(
      theme.muted(
        t(
          "update.tagIgnoredForGit",
          {},
          "Note: --tag applies to npm installs only; git updates ignore it.",
        ),
      ),
    );
  }

  if (requestedChannel && configSnapshot.valid) {
    const next = {
      ...configSnapshot.config,
      update: {
        ...configSnapshot.config.update,
        channel: requestedChannel,
      },
    };
    await writeConfigFile(next);
    activeConfig = next;
    if (!opts.json) {
      defaultRuntime.log(
        theme.muted(
          t(
            "update.channelSet",
            { channel: requestedChannel },
            `Update channel set to ${requestedChannel}.`,
          ),
        ),
      );
    }
  }

  const showProgress = !opts.json && process.stdout.isTTY;

  if (!opts.json) {
    defaultRuntime.log(theme.heading(t("update.updatingHeading", {}, "Updating OpenClaw...")));
    defaultRuntime.log("");
  }

  const { progress, stop } = createUpdateProgress(showProgress);

  const startedAt = Date.now();
  let result: UpdateRunResult;

  if (switchToPackage) {
    const manager = await resolveGlobalManager({
      root,
      installKind,
      timeoutMs: timeoutMs ?? 20 * 60_000,
    });
    const runCommand = async (argv: string[], options: { timeoutMs: number }) => {
      const res = await runCommandWithTimeout(argv, options);
      return { stdout: res.stdout, stderr: res.stderr, code: res.code };
    };
    const pkgRoot = await resolveGlobalPackageRoot(manager, runCommand, timeoutMs ?? 20 * 60_000);
    const packageName =
      (pkgRoot ? await readPackageName(pkgRoot) : await readPackageName(root)) ??
      DEFAULT_PACKAGE_NAME;
    const beforeVersion = pkgRoot ? await readPackageVersion(pkgRoot) : null;
    if (pkgRoot) {
      await cleanupGlobalRenameDirs({
        globalRoot: path.dirname(pkgRoot),
        packageName,
      });
    }
    const updateStep = await runUpdateStep({
      name: "global update",
      argv: globalInstallArgs(manager, `${packageName}@${tag}`),
      timeoutMs: timeoutMs ?? 20 * 60_000,
      progress,
    });
    const steps = [updateStep];
    let afterVersion = beforeVersion;
    if (pkgRoot) {
      afterVersion = await readPackageVersion(pkgRoot);
      const entryPath = path.join(pkgRoot, "dist", "entry.js");
      if (await pathExists(entryPath)) {
        const doctorStep = await runUpdateStep({
          name: `${CLI_NAME} doctor`,
          argv: [resolveNodeRunner(), entryPath, "doctor", "--non-interactive"],
          timeoutMs: timeoutMs ?? 20 * 60_000,
          progress,
        });
        steps.push(doctorStep);
      }
    }
    const failedStep = steps.find((step) => step.exitCode !== 0);
    result = {
      status: failedStep ? "error" : "ok",
      mode: manager,
      root: pkgRoot ?? root,
      reason: failedStep ? failedStep.name : undefined,
      before: { version: beforeVersion },
      after: { version: afterVersion },
      steps,
      durationMs: Date.now() - startedAt,
    };
  } else {
    const updateRoot = switchToGit ? resolveGitInstallDir() : root;
    const cloneStep = switchToGit
      ? await ensureGitCheckout({
          dir: updateRoot,
          timeoutMs: timeoutMs ?? 20 * 60_000,
          progress,
        })
      : null;
    if (cloneStep && cloneStep.exitCode !== 0) {
      result = {
        status: "error",
        mode: "git",
        root: updateRoot,
        reason: cloneStep.name,
        steps: [cloneStep],
        durationMs: Date.now() - startedAt,
      };
      stop();
      printResult(result, { ...opts, hideSteps: showProgress });
      defaultRuntime.exit(1);
      return;
    }
    const updateResult = await runGatewayUpdate({
      cwd: updateRoot,
      argv1: switchToGit ? undefined : process.argv[1],
      timeoutMs,
      progress,
      channel,
      tag,
    });
    const steps = [...(cloneStep ? [cloneStep] : []), ...updateResult.steps];
    if (switchToGit && updateResult.status === "ok") {
      const manager = await resolveGlobalManager({
        root,
        installKind,
        timeoutMs: timeoutMs ?? 20 * 60_000,
      });
      const installStep = await runUpdateStep({
        name: "global install",
        argv: globalInstallArgs(manager, updateRoot),
        cwd: updateRoot,
        timeoutMs: timeoutMs ?? 20 * 60_000,
        progress,
      });
      steps.push(installStep);
      const failedStep = [installStep].find((step) => step.exitCode !== 0);
      result = {
        ...updateResult,
        status: updateResult.status === "ok" && !failedStep ? "ok" : "error",
        steps,
        durationMs: Date.now() - startedAt,
      };
    } else {
      result = {
        ...updateResult,
        steps,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  stop();

  printResult(result, { ...opts, hideSteps: showProgress });

  if (result.status === "error") {
    defaultRuntime.exit(1);
    return;
  }

  if (result.status === "skipped") {
    if (result.reason === "dirty") {
      defaultRuntime.log(
        theme.warn(
          t(
            "update.skippedDirty",
            {},
            "Skipped: working directory has uncommitted changes. Commit or stash them first.",
          ),
        ),
      );
    }
    if (result.reason === "not-git-install") {
      defaultRuntime.log(
        theme.warn(
          t(
            "update.skippedNotGitInstall",
            {
              doctorCmd: replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME),
              restartCmd: replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME),
            },
            `Skipped: this OpenClaw install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\` and \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\`.`,
          ),
        ),
      );
      defaultRuntime.log(
        theme.muted(
          t(
            "update.skippedNotGitInstallExamples",
            {
              npmCmd: replaceCliName("npm i -g openclaw@latest", CLI_NAME),
              pnpmCmd: replaceCliName("pnpm add -g openclaw@latest", CLI_NAME),
            },
            `Examples: \`${replaceCliName("npm i -g openclaw@latest", CLI_NAME)}\` or \`${replaceCliName("pnpm add -g openclaw@latest", CLI_NAME)}\``,
          ),
        ),
      );
    }
    defaultRuntime.exit(0);
    return;
  }

  if (activeConfig) {
    const pluginLogger = opts.json
      ? {}
      : {
          info: (msg: string) => defaultRuntime.log(msg),
          warn: (msg: string) => defaultRuntime.log(theme.warn(msg)),
          error: (msg: string) => defaultRuntime.log(theme.error(msg)),
        };

    if (!opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(
        theme.heading(t("update.updatingPluginsHeading", {}, "Updating plugins...")),
      );
    }

    const syncResult = await syncPluginsForUpdateChannel({
      config: activeConfig,
      channel,
      workspaceDir: root,
      logger: pluginLogger,
    });
    let pluginConfig = syncResult.config;

    const npmResult = await updateNpmInstalledPlugins({
      config: pluginConfig,
      skipIds: new Set(syncResult.summary.switchedToNpm),
      logger: pluginLogger,
    });
    pluginConfig = npmResult.config;

    if (syncResult.changed || npmResult.changed) {
      await writeConfigFile(pluginConfig);
    }

    if (!opts.json) {
      const summarizeList = (list: string[]) => {
        if (list.length <= 6) {
          return list.join(", ");
        }
        return `${list.slice(0, 6).join(", ")} +${list.length - 6} more`;
      };

      if (syncResult.summary.switchedToBundled.length > 0) {
        defaultRuntime.log(
          theme.muted(
            t(
              "update.switchedToBundled",
              { plugins: summarizeList(syncResult.summary.switchedToBundled) },
              `Switched to bundled plugins: ${summarizeList(syncResult.summary.switchedToBundled)}.`,
            ),
          ),
        );
      }
      if (syncResult.summary.switchedToNpm.length > 0) {
        defaultRuntime.log(
          theme.muted(
            t(
              "update.restoredNpmPlugins",
              { plugins: summarizeList(syncResult.summary.switchedToNpm) },
              `Restored npm plugins: ${summarizeList(syncResult.summary.switchedToNpm)}.`,
            ),
          ),
        );
      }
      for (const warning of syncResult.summary.warnings) {
        defaultRuntime.log(theme.warn(warning));
      }
      for (const error of syncResult.summary.errors) {
        defaultRuntime.log(theme.error(error));
      }

      const updated = npmResult.outcomes.filter((entry) => entry.status === "updated").length;
      const unchanged = npmResult.outcomes.filter((entry) => entry.status === "unchanged").length;
      const failed = npmResult.outcomes.filter((entry) => entry.status === "error").length;
      const skipped = npmResult.outcomes.filter((entry) => entry.status === "skipped").length;

      if (npmResult.outcomes.length === 0) {
        defaultRuntime.log(
          theme.muted(t("update.noPluginUpdatesNeeded", {}, "No plugin updates needed.")),
        );
      } else {
        const parts = [
          t("update.pluginsUpdatedCount", { count: updated }, `${updated} updated`),
          t("update.pluginsUnchangedCount", { count: unchanged }, `${unchanged} unchanged`),
        ];
        if (failed > 0) {
          parts.push(t("update.pluginsFailedCount", { count: failed }, `${failed} failed`));
        }
        if (skipped > 0) {
          parts.push(t("update.pluginsSkippedCount", { count: skipped }, `${skipped} skipped`));
        }
        defaultRuntime.log(
          theme.muted(
            t(
              "update.npmPluginsSummary",
              { summary: parts.join(", ") },
              `npm plugins: ${parts.join(", ")}.`,
            ),
          ),
        );
      }

      for (const outcome of npmResult.outcomes) {
        if (outcome.status !== "error") {
          continue;
        }
        defaultRuntime.log(theme.error(outcome.message));
      }
    }
  } else if (!opts.json) {
    defaultRuntime.log(
      theme.warn(
        t("update.skippingPluginsConfigInvalid", {}, "Skipping plugin updates: config is invalid."),
      ),
    );
  }

  await tryWriteCompletionCache(root, Boolean(opts.json));

  // Offer to install shell completion if not already installed
  await tryInstallShellCompletion({
    jsonMode: Boolean(opts.json),
    skipPrompt: Boolean(opts.yes),
  });

  // Restart service if requested
  if (shouldRestart) {
    if (!opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(
        theme.heading(t("update.restartingServiceHeading", {}, "Restarting service...")),
      );
    }
    try {
      const restarted = await runDaemonRestart();
      if (!opts.json && restarted) {
        defaultRuntime.log(
          theme.success(
            t("update.daemonRestartedSuccessfully", {}, "Daemon restarted successfully."),
          ),
        );
        defaultRuntime.log("");
        process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
        try {
          const interactiveDoctor = Boolean(process.stdin.isTTY) && !opts.json && opts.yes !== true;
          await doctorCommand(defaultRuntime, {
            nonInteractive: !interactiveDoctor,
          });
        } catch (err) {
          defaultRuntime.log(
            theme.warn(
              t("update.doctorFailed", { error: String(err) }, `Doctor failed: ${String(err)}`),
            ),
          );
        } finally {
          delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
        }
      }
    } catch (err) {
      if (!opts.json) {
        defaultRuntime.log(
          theme.warn(
            t(
              "update.daemonRestartFailed",
              { error: String(err) },
              `Daemon restart failed: ${String(err)}`,
            ),
          ),
        );
        defaultRuntime.log(
          theme.muted(
            t(
              "update.manualRestartHint",
              { command: replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME) },
              `You may need to restart the service manually: ${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}`,
            ),
          ),
        );
      }
    }
  } else if (!opts.json) {
    defaultRuntime.log("");
    if (result.mode === "npm" || result.mode === "pnpm") {
      defaultRuntime.log(
        theme.muted(
          t(
            "update.tipDoctorAndRestart",
            {
              doctorCmd: replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME),
              restartCmd: replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME),
            },
            `Tip: Run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\`, then \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
          ),
        ),
      );
    } else {
      defaultRuntime.log(
        theme.muted(
          t(
            "update.tipRestart",
            { command: replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME) },
            `Tip: Run \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
          ),
        ),
      );
    }
  }

  if (!opts.json) {
    defaultRuntime.log(theme.muted(pickUpdateQuip()));
  }
}

export async function updateWizardCommand(opts: UpdateWizardOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    defaultRuntime.error(
      t(
        "update.wizardRequiresTty",
        {},
        "Update wizard requires a TTY. Use `openclaw update --channel <stable|beta|dev>` instead.",
      ),
    );
    defaultRuntime.exit(1);
    return;
  }

  const timeoutMs = opts.timeout ? Number.parseInt(opts.timeout, 10) * 1000 : undefined;
  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
    defaultRuntime.error(
      t("update.timeoutInvalid", {}, "--timeout must be a positive integer (seconds)"),
    );
    defaultRuntime.exit(1);
    return;
  }

  const root =
    (await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd();

  const [updateStatus, configSnapshot] = await Promise.all([
    checkUpdateStatus({
      root,
      timeoutMs: timeoutMs ?? 3500,
      fetchGit: false,
      includeRegistry: false,
    }),
    readConfigFileSnapshot(),
  ]);

  const configChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;
  const channelInfo = resolveEffectiveUpdateChannel({
    configChannel,
    installKind: updateStatus.installKind,
    git: updateStatus.git
      ? { tag: updateStatus.git.tag, branch: updateStatus.git.branch }
      : undefined,
  });
  const channelLabel = formatUpdateChannelLabel({
    channel: channelInfo.channel,
    source: channelInfo.source,
    gitTag: updateStatus.git?.tag ?? null,
    gitBranch: updateStatus.git?.branch ?? null,
  });

  const pickedChannel = await selectStyled({
    message: t("update.wizardChannelPrompt", {}, "Update channel"),
    options: [
      {
        value: "keep",
        label: t(
          "update.wizardKeepCurrent",
          { channel: channelInfo.channel },
          `Keep current (${channelInfo.channel})`,
        ),
        hint: channelLabel,
      },
      {
        value: "stable",
        label: t("update.wizardStable", {}, "Stable"),
        hint: t("update.wizardStableHint", {}, "Tagged releases (npm latest)"),
      },
      {
        value: "beta",
        label: t("update.wizardBeta", {}, "Beta"),
        hint: t("update.wizardBetaHint", {}, "Prereleases (npm beta)"),
      },
      {
        value: "dev",
        label: t("update.wizardDev", {}, "Dev"),
        hint: t("update.wizardDevHint", {}, "Git main"),
      },
    ],
    initialValue: "keep",
  });

  if (isCancel(pickedChannel)) {
    defaultRuntime.log(theme.muted(t("update.cancelled", {}, "Update cancelled.")));
    defaultRuntime.exit(0);
    return;
  }

  const requestedChannel = pickedChannel === "keep" ? null : pickedChannel;

  if (requestedChannel === "dev" && updateStatus.installKind !== "git") {
    const gitDir = resolveGitInstallDir();
    const hasGit = await isGitCheckout(gitDir);
    if (!hasGit) {
      const dirExists = await pathExists(gitDir);
      if (dirExists) {
        const empty = await isEmptyDir(gitDir);
        if (!empty) {
          defaultRuntime.error(
            t(
              "update.nonGitDirectory",
              { dir: gitDir },
              `OPENCLAW_GIT_DIR points at a non-git directory: ${gitDir}. Set OPENCLAW_GIT_DIR to an empty folder or an openclaw checkout.`,
            ),
          );
          defaultRuntime.exit(1);
          return;
        }
      }
      const ok = await confirm({
        message: stylePromptMessage(
          t(
            "update.createGitCheckout",
            { dir: gitDir },
            `Create a git checkout at ${gitDir}? (override via OPENCLAW_GIT_DIR)`,
          ),
        ),
        initialValue: true,
      });
      if (isCancel(ok) || !ok) {
        defaultRuntime.log(theme.muted(t("update.cancelled", {}, "Update cancelled.")));
        defaultRuntime.exit(0);
        return;
      }
    }
  }

  const restart = await confirm({
    message: stylePromptMessage(
      t("update.restartAfterUpdate", {}, "Restart the gateway service after update?"),
    ),
    initialValue: true,
  });
  if (isCancel(restart)) {
    defaultRuntime.log(theme.muted(t("update.cancelled", {}, "Update cancelled.")));
    defaultRuntime.exit(0);
    return;
  }

  try {
    await updateCommand({
      channel: requestedChannel ?? undefined,
      restart: Boolean(restart),
      timeout: opts.timeout,
    });
  } catch (err) {
    defaultRuntime.error(String(err));
    defaultRuntime.exit(1);
  }
}

export function registerUpdateCli(program: Command) {
  const update = program
    .command("update")
    .description(t("update.cliDescription", {}, "Update OpenClaw to the latest version"))
    .option("--json", t("update.cliOptionJson", {}, "Output result as JSON"), false)
    .option(
      "--no-restart",
      t(
        "update.cliOptionNoRestart",
        {},
        "Skip restarting the gateway service after a successful update",
      ),
    )
    .option(
      "--channel <stable|beta|dev>",
      t("update.cliOptionChannel", {}, "Persist update channel (git + npm)"),
    )
    .option(
      "--tag <dist-tag|version>",
      t("update.cliOptionTag", {}, "Override npm dist-tag or version for this update"),
    )
    .option(
      "--timeout <seconds>",
      t("update.cliOptionTimeout", {}, "Timeout for each update step in seconds (default: 1200)"),
    )
    .option(
      "--yes",
      t("update.cliOptionYes", {}, "Skip confirmation prompts (non-interactive)"),
      false,
    )
    .addHelpText("after", () => {
      const examples = [
        ["openclaw update", t("update.helpExampleUpdate", {}, "Update a source checkout (git)")],
        [
          "openclaw update --channel beta",
          t("update.helpExampleChannelBeta", {}, "Switch to beta channel (git + npm)"),
        ],
        [
          "openclaw update --channel dev",
          t("update.helpExampleChannelDev", {}, "Switch to dev channel (git + npm)"),
        ],
        [
          "openclaw update --tag beta",
          t("update.helpExampleTag", {}, "One-off update to a dist-tag or version"),
        ],
        [
          "openclaw update --no-restart",
          t("update.helpExampleNoRestart", {}, "Update without restarting the service"),
        ],
        ["openclaw update --json", t("update.helpExampleJson", {}, "Output result as JSON")],
        [
          "openclaw update --yes",
          t("update.helpExampleYes", {}, "Non-interactive (accept downgrade prompts)"),
        ],
        ["openclaw update wizard", t("update.helpExampleWizard", {}, "Interactive update wizard")],
        [
          "openclaw --update",
          t("update.helpExampleShorthand", {}, "Shorthand for openclaw update"),
        ],
      ] as const;
      const fmtExamples = examples
        .map(([cmd, desc]) => `  ${theme.command(cmd)} ${theme.muted(`# ${desc}`)}`)
        .join("\n");
      return `
${theme.heading(t("update.helpWhatThisDoes", {}, "What this does:"))}
  - ${t("update.helpGitCheckouts", {}, "Git checkouts: fetches, rebases, installs deps, builds, and runs doctor")}
  - ${t("update.helpNpmInstalls", {}, "npm installs: updates via detected package manager")}

${theme.heading(t("update.helpSwitchChannels", {}, "Switch channels:"))}
  - ${t("update.helpChannelPersist", {}, "Use --channel stable|beta|dev to persist the update channel in config")}
  - ${t("update.helpChannelStatus", {}, "Run openclaw update status to see the active channel and source")}
  - ${t("update.helpTagOneOff", {}, "Use --tag <dist-tag|version> for a one-off npm update without persisting")}

${theme.heading(t("update.helpNonInteractive", {}, "Non-interactive:"))}
  - ${t("update.helpYesFlag", {}, "Use --yes to accept downgrade prompts")}
  - ${t("update.helpCombineFlags", {}, "Combine with --channel/--tag/--restart/--json/--timeout as needed")}

${theme.heading(t("update.helpExamplesHeading", {}, "Examples:"))}
${fmtExamples}

${theme.heading(t("update.helpNotesHeading", {}, "Notes:"))}
  - ${t("update.helpNoteSwitchChannels", {}, "Switch channels with --channel stable|beta|dev")}
  - ${t("update.helpNoteGlobalInstalls", {}, "For global installs: auto-updates via detected package manager when possible (see docs/install/updating.md)")}
  - ${t("update.helpNoteDowngrades", {}, "Downgrades require confirmation (can break configuration)")}
  - ${t("update.helpNoteSkipDirty", {}, "Skips update if the working directory has uncommitted changes")}

${theme.muted(t("update.helpDocs", {}, "Docs:"))} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}`;
    })
    .action(async (opts) => {
      try {
        await updateCommand({
          json: Boolean(opts.json),
          restart: Boolean(opts.restart),
          channel: opts.channel as string | undefined,
          tag: opts.tag as string | undefined,
          timeout: opts.timeout as string | undefined,
          yes: Boolean(opts.yes),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  update
    .command("wizard")
    .description(t("update.wizardDescription", {}, "Interactive update wizard"))
    .option(
      "--timeout <seconds>",
      t("update.cliOptionTimeout", {}, "Timeout for each update step in seconds (default: 1200)"),
    )
    .addHelpText(
      "after",
      `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}\n`,
    )
    .action(async (opts) => {
      try {
        await updateWizardCommand({
          timeout: opts.timeout as string | undefined,
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  update
    .command("status")
    .description(t("update.statusDescription", {}, "Show update channel and version status"))
    .option("--json", t("update.cliOptionJson", {}, "Output result as JSON"), false)
    .option(
      "--timeout <seconds>",
      t("update.statusTimeoutOption", {}, "Timeout for update checks in seconds (default: 3)"),
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading(t("update.helpExamplesHeading", {}, "Examples:"))}\n${formatHelpExamples(
          [
            [
              "openclaw update status",
              t("update.statusHelpExampleStatus", {}, "Show channel + version status."),
            ],
            [
              "openclaw update status --json",
              t("update.statusHelpExampleJson", {}, "JSON output."),
            ],
            [
              "openclaw update status --timeout 10",
              t("update.statusHelpExampleTimeout", {}, "Custom timeout."),
            ],
          ],
        )}\n\n${theme.heading(t("update.helpNotesHeading", {}, "Notes:"))}\n${theme.muted(
          t(
            "update.statusNoteChannel",
            {},
            "- Shows current update channel (stable/beta/dev) and source",
          ),
        )}\n${theme.muted(t("update.statusNoteGit", {}, "- Includes git tag/branch/SHA for source checkouts"))}\n\n${theme.muted(
          t("update.helpDocs", {}, "Docs:"),
        )} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}`,
    )
    .action(async (opts) => {
      try {
        await updateStatusCommand({
          json: Boolean(opts.json),
          timeout: opts.timeout as string | undefined,
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
