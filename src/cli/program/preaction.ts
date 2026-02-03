import type { Command } from "commander";
import { readConfigFileSnapshot } from "../../config/config.js";
import { setVerbose } from "../../globals.js";
import { initI18n } from "../../i18n/index.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { defaultRuntime } from "../../runtime.js";
import { getCommandPath, getLanguageFlag, getVerboseFlag, hasHelpOrVersion } from "../argv.js";
import { emitCliBanner } from "../banner.js";
import { resolveCliName } from "../cli-name.js";
import { ensurePluginRegistryLoaded } from "../plugin-registry.js";
import { ensureConfigReady } from "./config-guard.js";

function setProcessTitleForCommand(actionCommand: Command) {
  let current: Command = actionCommand;
  while (current.parent && current.parent.parent) {
    current = current.parent;
  }
  const name = current.name();
  const cliName = resolveCliName();
  if (!name || name === cliName) {
    return;
  }
  process.title = `${cliName}-${name}`;
}

// Commands that need channel plugins loaded
const PLUGIN_REQUIRED_COMMANDS = new Set(["message", "channels", "directory"]);

async function initializeI18n(argv: string[]) {
  // Priority: CLI flag > config > env > auto-detect
  const languageFlag = getLanguageFlag(argv);

  if (languageFlag) {
    // Use CLI flag
    initI18n({ locale: languageFlag });
    return;
  }

  // Try to read config for language setting
  try {
    const snapshot = await readConfigFileSnapshot();
    if (snapshot.valid && snapshot.config.language) {
      initI18n({ configLocale: snapshot.config.language });
      return;
    }
  } catch {
    // Ignore errors, fall back to auto-detect
  }

  // Auto-detect from environment
  initI18n();
}

export function registerPreActionHooks(program: Command, programVersion: string) {
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    setProcessTitleForCommand(actionCommand);
    const argv = process.argv;

    // Initialize i18n early (before banner and other outputs)
    await initializeI18n(argv);

    if (hasHelpOrVersion(argv)) {
      return;
    }
    const commandPath = getCommandPath(argv, 2);
    const hideBanner =
      isTruthyEnvValue(process.env.OPENCLAW_HIDE_BANNER) ||
      commandPath[0] === "update" ||
      commandPath[0] === "completion" ||
      (commandPath[0] === "plugins" && commandPath[1] === "update");
    if (!hideBanner) {
      emitCliBanner(programVersion);
    }
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    setVerbose(verbose);
    if (!verbose) {
      process.env.NODE_NO_WARNINGS ??= "1";
    }
    if (commandPath[0] === "doctor" || commandPath[0] === "completion") {
      return;
    }
    await ensureConfigReady({ runtime: defaultRuntime, commandPath });
    // Load plugins for commands that need channel access
    if (PLUGIN_REQUIRED_COMMANDS.has(commandPath[0])) {
      ensurePluginRegistryLoaded();
    }
  });
}
