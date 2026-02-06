import type {
  GatewayAuthChoice,
  OnboardMode,
  OnboardOptions,
  ResetScope,
} from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { QuickstartGatewayDefaults, WizardFlow } from "./onboarding.types.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import { formatCliCommand } from "../cli/command-format.js";
import { promptAuthChoiceGrouped } from "../commands/auth-choice-prompt.js";
import {
  applyAuthChoice,
  resolvePreferredProviderForAuthChoice,
  warnIfModelConfigLooksOff,
} from "../commands/auth-choice.js";
import { applyPrimaryModel, promptDefaultModel } from "../commands/model-picker.js";
import { setupChannels } from "../commands/onboard-channels.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  handleReset,
  printWizardHeader,
  probeGatewayReachable,
  summarizeExistingConfig,
} from "../commands/onboard-helpers.js";
import { setupInternalHooks } from "../commands/onboard-hooks.js";
import { promptRemoteGatewayConfig } from "../commands/onboard-remote.js";
import { setupSkills } from "../commands/onboard-skills.js";
import {
  DEFAULT_GATEWAY_PORT,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { initI18n, t } from "../i18n/index.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { finalizeOnboardingWizard } from "./onboarding.finalize.js";
import { configureGatewayForOnboarding } from "./onboarding.gateway-config.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";

async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
}) {
  if (params.opts.acceptRisk === true) {
    return;
  }

  await params.prompter.note(t("onboard.security.warning"), t("onboard.security.title"));

  const ok = await params.prompter.confirm({
    message: t("onboard.security.confirm"),
    initialValue: false,
  });
  if (!ok) {
    throw new WizardCancelledError(t("onboard.security.notAccepted"));
  }
}

export async function runOnboardingWizard(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
  prompter: WizardPrompter,
) {
  // Initialize i18n before any translated output
  initI18n();

  printWizardHeader(runtime);
  await prompter.intro(t("onboard.title"));
  await requireRiskAcknowledgement({ opts, prompter });

  const snapshot = await readConfigFileSnapshot();
  let baseConfig: OpenClawConfig = snapshot.valid ? snapshot.config : {};

  if (snapshot.exists && !snapshot.valid) {
    await prompter.note(
      summarizeExistingConfig(baseConfig),
      t("onboard.config.invalidTitle", {}, "Invalid config"),
    );
    if (snapshot.issues.length > 0) {
      await prompter.note(
        [
          ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
          "",
          t("onboard.config.docsLink", {}, "Docs: https://docs.openclaw.ai/gateway/configuration"),
        ].join("\n"),
        t("onboard.config.issuesTitle", {}, "Config issues"),
      );
    }
    await prompter.outro(
      t(
        "onboard.config.invalidMessage",
        { command: formatCliCommand("openclaw doctor") },
        `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run onboarding.`,
      ),
    );
    runtime.exit(1);
    return;
  }

  const quickstartHint = t("onboard.flow.quickstartHint", {
    command: formatCliCommand("openclaw configure"),
  });
  const manualHint = t("onboard.flow.advancedHint");
  const explicitFlowRaw = opts.flow?.trim();
  const normalizedExplicitFlow = explicitFlowRaw === "manual" ? "advanced" : explicitFlowRaw;
  if (
    normalizedExplicitFlow &&
    normalizedExplicitFlow !== "quickstart" &&
    normalizedExplicitFlow !== "advanced"
  ) {
    runtime.error(t("onboard.flow.invalid"));
    runtime.exit(1);
    return;
  }
  const explicitFlow: WizardFlow | undefined =
    normalizedExplicitFlow === "quickstart" || normalizedExplicitFlow === "advanced"
      ? normalizedExplicitFlow
      : undefined;
  let flow: WizardFlow =
    explicitFlow ??
    (await prompter.select({
      message: t("onboard.flow.title"),
      options: [
        { value: "quickstart", label: t("onboard.flow.quickstart"), hint: quickstartHint },
        { value: "advanced", label: t("onboard.flow.advanced"), hint: manualHint },
      ],
      initialValue: "quickstart",
    }));

  if (opts.mode === "remote" && flow === "quickstart") {
    await prompter.note(t("onboard.flow.quickstartOnlyLocal"), t("onboard.flow.quickstart"));
    flow = "advanced";
  }

  if (snapshot.exists) {
    await prompter.note(summarizeExistingConfig(baseConfig), t("onboard.config.existingTitle"));

    const action = await prompter.select({
      message: t("onboard.config.handling"),
      options: [
        { value: "keep", label: t("onboard.config.keepExisting") },
        { value: "modify", label: t("onboard.config.updateValues") },
        { value: "reset", label: t("onboard.config.reset") },
      ],
    });

    if (action === "reset") {
      const workspaceDefault = baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE;
      const resetScope = (await prompter.select({
        message: t("onboard.reset.scope"),
        options: [
          { value: "config", label: t("onboard.reset.configOnly") },
          {
            value: "config+creds+sessions",
            label: t("onboard.reset.configCredsSeessions"),
          },
          {
            value: "full",
            label: t("onboard.reset.full"),
          },
        ],
      })) as ResetScope;
      await handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
      baseConfig = {};
    }
  }

  const quickstartGateway: QuickstartGatewayDefaults = (() => {
    const hasExisting =
      typeof baseConfig.gateway?.port === "number" ||
      baseConfig.gateway?.bind !== undefined ||
      baseConfig.gateway?.auth?.mode !== undefined ||
      baseConfig.gateway?.auth?.token !== undefined ||
      baseConfig.gateway?.auth?.password !== undefined ||
      baseConfig.gateway?.customBindHost !== undefined ||
      baseConfig.gateway?.tailscale?.mode !== undefined;

    const bindRaw = baseConfig.gateway?.bind;
    const bind =
      bindRaw === "loopback" ||
      bindRaw === "lan" ||
      bindRaw === "auto" ||
      bindRaw === "custom" ||
      bindRaw === "tailnet"
        ? bindRaw
        : "loopback";

    let authMode: GatewayAuthChoice = "token";
    if (
      baseConfig.gateway?.auth?.mode === "token" ||
      baseConfig.gateway?.auth?.mode === "password"
    ) {
      authMode = baseConfig.gateway.auth.mode;
    } else if (baseConfig.gateway?.auth?.token) {
      authMode = "token";
    } else if (baseConfig.gateway?.auth?.password) {
      authMode = "password";
    }

    const tailscaleRaw = baseConfig.gateway?.tailscale?.mode;
    const tailscaleMode =
      tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel"
        ? tailscaleRaw
        : "off";

    return {
      hasExisting,
      port: resolveGatewayPort(baseConfig),
      bind,
      authMode,
      tailscaleMode,
      token: baseConfig.gateway?.auth?.token,
      password: baseConfig.gateway?.auth?.password,
      customBindHost: baseConfig.gateway?.customBindHost,
      tailscaleResetOnExit: baseConfig.gateway?.tailscale?.resetOnExit ?? false,
    };
  })();

  if (flow === "quickstart") {
    const formatBind = (value: "loopback" | "lan" | "auto" | "custom" | "tailnet") => {
      if (value === "loopback") {
        return t("onboard.quickstart.bindLoopback", {}, "Loopback (127.0.0.1)");
      }
      if (value === "lan") {
        return t("onboard.quickstart.bindLan", {}, "LAN");
      }
      if (value === "custom") {
        return t("onboard.quickstart.bindCustom", {}, "Custom IP");
      }
      if (value === "tailnet") {
        return t("onboard.quickstart.bindTailnet", {}, "Tailnet (Tailscale IP)");
      }
      return t("onboard.quickstart.bindAuto", {}, "Auto");
    };
    const formatAuth = (value: GatewayAuthChoice) => {
      if (value === "token") {
        return t("onboard.quickstart.authToken", {}, "Token (default)");
      }
      return t("onboard.quickstart.authPassword", {}, "Password");
    };
    const formatTailscale = (value: "off" | "serve" | "funnel") => {
      if (value === "off") {
        return t("onboard.quickstart.tailscaleOff", {}, "Off");
      }
      if (value === "serve") {
        return t("onboard.quickstart.tailscaleServe", {}, "Serve");
      }
      return t("onboard.quickstart.tailscaleFunnel", {}, "Funnel");
    };
    const quickstartLines = quickstartGateway.hasExisting
      ? [
          t("onboard.quickstart.keepingSettings", {}, "Keeping your current gateway settings:"),
          t(
            "onboard.quickstart.gatewayPort",
            { port: quickstartGateway.port },
            `Gateway port: ${quickstartGateway.port}`,
          ),
          t(
            "onboard.quickstart.gatewayBind",
            { bind: formatBind(quickstartGateway.bind) },
            `Gateway bind: ${formatBind(quickstartGateway.bind)}`,
          ),
          ...(quickstartGateway.bind === "custom" && quickstartGateway.customBindHost
            ? [
                t(
                  "onboard.quickstart.gatewayCustomIp",
                  { ip: quickstartGateway.customBindHost },
                  `Gateway custom IP: ${quickstartGateway.customBindHost}`,
                ),
              ]
            : []),
          t(
            "onboard.quickstart.gatewayAuth",
            { auth: formatAuth(quickstartGateway.authMode) },
            `Gateway auth: ${formatAuth(quickstartGateway.authMode)}`,
          ),
          t(
            "onboard.quickstart.tailscaleExposure",
            { mode: formatTailscale(quickstartGateway.tailscaleMode) },
            `Tailscale exposure: ${formatTailscale(quickstartGateway.tailscaleMode)}`,
          ),
          t("onboard.quickstart.directToChannels", {}, "Direct to chat channels."),
        ]
      : [
          t(
            "onboard.quickstart.gatewayPort",
            { port: DEFAULT_GATEWAY_PORT },
            `Gateway port: ${DEFAULT_GATEWAY_PORT}`,
          ),
          t(
            "onboard.quickstart.gatewayBind",
            { bind: t("onboard.quickstart.bindLoopback", {}, "Loopback (127.0.0.1)") },
            "Gateway bind: Loopback (127.0.0.1)",
          ),
          t(
            "onboard.quickstart.gatewayAuth",
            { auth: t("onboard.quickstart.authToken", {}, "Token (default)") },
            "Gateway auth: Token (default)",
          ),
          t(
            "onboard.quickstart.tailscaleExposure",
            { mode: t("onboard.quickstart.tailscaleOff", {}, "Off") },
            "Tailscale exposure: Off",
          ),
          t("onboard.quickstart.directToChannels", {}, "Direct to chat channels."),
        ];
    await prompter.note(
      quickstartLines.join("\n"),
      t("onboard.quickstart.title", {}, "QuickStart"),
    );
  }

  const localPort = resolveGatewayPort(baseConfig);
  const localUrl = `ws://127.0.0.1:${localPort}`;
  const localProbe = await probeGatewayReachable({
    url: localUrl,
    token: baseConfig.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN,
    password: baseConfig.gateway?.auth?.password ?? process.env.OPENCLAW_GATEWAY_PASSWORD,
  });
  const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
  const remoteProbe = remoteUrl
    ? await probeGatewayReachable({
        url: remoteUrl,
        token: baseConfig.gateway?.remote?.token,
      })
    : null;

  const mode =
    opts.mode ??
    (flow === "quickstart"
      ? "local"
      : ((await prompter.select({
          message: t("onboard.mode.title", {}, "What do you want to set up?"),
          options: [
            {
              value: "local",
              label: t("onboard.mode.local", {}, "Local gateway (this machine)"),
              hint: localProbe.ok
                ? t(
                    "onboard.mode.localHintReachable",
                    { url: localUrl },
                    `Gateway reachable (${localUrl})`,
                  )
                : t(
                    "onboard.mode.localHintUnreachable",
                    { url: localUrl },
                    `No gateway detected (${localUrl})`,
                  ),
            },
            {
              value: "remote",
              label: t("onboard.mode.remote", {}, "Remote gateway (info-only)"),
              hint: !remoteUrl
                ? t("onboard.mode.remoteHintNone", {}, "No remote URL configured yet")
                : remoteProbe?.ok
                  ? t(
                      "onboard.mode.remoteHintReachable",
                      { url: remoteUrl },
                      `Gateway reachable (${remoteUrl})`,
                    )
                  : t(
                      "onboard.mode.remoteHintUnreachable",
                      { url: remoteUrl },
                      `Configured but unreachable (${remoteUrl})`,
                    ),
            },
          ],
        })) as OnboardMode));

  if (mode === "remote") {
    let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
    nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
    await writeConfigFile(nextConfig);
    logConfigUpdated(runtime);
    await prompter.outro(t("onboard.mode.remoteConfigured", {}, "Remote gateway configured."));
    return;
  }

  const workspaceInput =
    opts.workspace ??
    (flow === "quickstart"
      ? (baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE)
      : await prompter.text({
          message: t("onboard.workspace.title", {}, "Workspace directory"),
          initialValue: baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE,
        }));

  const workspaceDir = resolveUserPath(workspaceInput.trim() || DEFAULT_WORKSPACE);

  let nextConfig: OpenClawConfig = {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...baseConfig.agents?.defaults,
        workspace: workspaceDir,
      },
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
  };

  const authStore = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: false,
  });
  const authChoiceFromPrompt = opts.authChoice === undefined;
  const authChoice =
    opts.authChoice ??
    (await promptAuthChoiceGrouped({
      prompter,
      store: authStore,
      includeSkip: true,
    }));

  const authResult = await applyAuthChoice({
    authChoice,
    config: nextConfig,
    prompter,
    runtime,
    setDefaultModel: true,
    opts: {
      tokenProvider: opts.tokenProvider,
      token: opts.authChoice === "apiKey" && opts.token ? opts.token : undefined,
    },
  });
  nextConfig = authResult.config;

  if (authChoiceFromPrompt) {
    const modelSelection = await promptDefaultModel({
      config: nextConfig,
      prompter,
      allowKeep: true,
      ignoreAllowlist: true,
      preferredProvider: resolvePreferredProviderForAuthChoice(authChoice),
    });
    if (modelSelection.model) {
      nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
    }
  }

  await warnIfModelConfigLooksOff(nextConfig, prompter);

  const gateway = await configureGatewayForOnboarding({
    flow,
    baseConfig,
    nextConfig,
    localPort,
    quickstartGateway,
    prompter,
    runtime,
  });
  nextConfig = gateway.nextConfig;
  const settings = gateway.settings;

  if (opts.skipChannels ?? opts.skipProviders) {
    await prompter.note(
      t("onboard.channels.skipping", {}, "Skipping channel setup."),
      t("onboard.channels.title", {}, "Channels"),
    );
  } else {
    const quickstartAllowFromChannels =
      flow === "quickstart"
        ? listChannelPlugins()
            .filter((plugin) => plugin.meta.quickstartAllowFrom)
            .map((plugin) => plugin.id)
        : [];
    nextConfig = await setupChannels(nextConfig, runtime, prompter, {
      allowSignalInstall: true,
      forceAllowFromChannels: quickstartAllowFromChannels,
      skipDmPolicyPrompt: flow === "quickstart",
      skipConfirm: flow === "quickstart",
      quickstartDefaults: flow === "quickstart",
    });
  }

  await writeConfigFile(nextConfig);
  logConfigUpdated(runtime);
  await ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  if (opts.skipSkills) {
    await prompter.note(
      t("onboard.skills.skipping", {}, "Skipping skills setup."),
      t("onboard.skills.title", {}, "Skills"),
    );
  } else {
    nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
  }

  // Setup hooks (session memory on /new)
  nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);

  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);

  const { launchedTui } = await finalizeOnboardingWizard({
    flow,
    opts,
    baseConfig,
    nextConfig,
    workspaceDir,
    settings,
    prompter,
    runtime,
  });
  if (launchedTui) {
    return;
  }
}
