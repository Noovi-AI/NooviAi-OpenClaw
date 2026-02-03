import { Command } from "commander";
import { initI18n } from "../../i18n/index.js";
import { getLanguageFlag } from "../argv.js";
import { registerProgramCommands } from "./command-registry.js";
import { createProgramContext } from "./context.js";
import { configureProgramHelp } from "./help.js";
import { registerPreActionHooks } from "./preaction.js";

/**
 * Initialize i18n early so command descriptions can be translated.
 * This uses only CLI flags and env vars (no config file read at this point).
 */
function earlyI18nInit(argv: string[]) {
  const languageFlag = getLanguageFlag(argv);
  if (languageFlag) {
    initI18n({ locale: languageFlag });
  } else {
    // Auto-detect from env (OPENCLAW_LANGUAGE, LANG, etc.)
    initI18n();
  }
}

export function buildProgram() {
  const program = new Command();
  const ctx = createProgramContext();
  const argv = process.argv;

  // Initialize i18n early so command descriptions can be translated
  earlyI18nInit(argv);

  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);

  registerProgramCommands(program, ctx, argv);

  return program;
}
