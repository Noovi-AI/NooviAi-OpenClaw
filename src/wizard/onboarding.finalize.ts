import fs from "node:fs/promises";
import path from "node:path";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { GatewayWizardSettings, WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
} from "../commands/daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
} from "../commands/daemon-runtime.js";
import { formatHealthCheckFailure } from "../commands/health-format.js";
import { healthCommand } from "../commands/health.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  openUrlInBackground,
  probeGatewayReachable,
  waitForGatewayReachable,
  resolveControlUiLinks,
} from "../commands/onboard-helpers.js";
import { resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { t } from "../i18n/index.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import { runTui } from "../tui/tui.js";
import { resolveUserPath } from "../utils.js";

type FinalizeOnboardingOptions = {
  flow: WizardFlow;
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  workspaceDir: string;
  settings: GatewayWizardSettings;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
};

export async function finalizeOnboardingWizard(options: FinalizeOnboardingOptions) {
  const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;

  const withWizardProgress = async <T>(
    label: string,
    options: { doneMessage?: string },
    work: (progress: { update: (message: string) => void }) => Promise<T>,
  ): Promise<T> => {
    const progress = prompter.progress(label);
    try {
      return await work(progress);
    } finally {
      progress.stop(options.doneMessage);
    }
  };

  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  if (process.platform === "linux" && !systemdAvailable) {
    await prompter.note(
      t("onboard.finalize.systemd.unavailable"),
      t("onboard.finalize.systemd.label"),
    );
  }

  if (process.platform === "linux" && systemdAvailable) {
    const { ensureSystemdUserLingerInteractive } = await import("../commands/systemd-linger.js");
    await ensureSystemdUserLingerInteractive({
      runtime,
      prompter: {
        confirm: prompter.confirm,
        note: prompter.note,
      },
      reason: t("onboard.finalize.systemd.lingerReason"),
      requireConfirm: false,
    });
  }

  const explicitInstallDaemon =
    typeof opts.installDaemon === "boolean" ? opts.installDaemon : undefined;
  let installDaemon: boolean;
  if (explicitInstallDaemon !== undefined) {
    installDaemon = explicitInstallDaemon;
  } else if (process.platform === "linux" && !systemdAvailable) {
    installDaemon = false;
  } else if (flow === "quickstart") {
    installDaemon = true;
  } else {
    installDaemon = await prompter.confirm({
      message: t("onboard.finalize.service.installPrompt"),
      initialValue: true,
    });
  }

  if (process.platform === "linux" && !systemdAvailable && installDaemon) {
    await prompter.note(
      t("onboard.finalize.systemd.unavailableSkip"),
      t("onboard.finalize.service.label"),
    );
    installDaemon = false;
  }

  if (installDaemon) {
    const daemonRuntime =
      flow === "quickstart"
        ? DEFAULT_GATEWAY_DAEMON_RUNTIME
        : await prompter.select({
            message: t("onboard.finalize.service.runtimePrompt"),
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
          });
    if (flow === "quickstart") {
      await prompter.note(
        t("onboard.finalize.service.quickstartRuntime"),
        t("onboard.finalize.service.runtimePrompt"),
      );
    }
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    if (loaded) {
      const action = await prompter.select({
        message: t("onboard.finalize.service.alreadyInstalled"),
        options: [
          { value: "restart", label: t("onboard.finalize.service.restart") },
          { value: "reinstall", label: t("onboard.finalize.service.reinstall") },
          { value: "skip", label: t("onboard.finalize.service.skip") },
        ],
      });
      if (action === "restart") {
        await withWizardProgress(
          t("onboard.finalize.service.label"),
          { doneMessage: t("onboard.finalize.service.restarted") },
          async (progress) => {
            progress.update(t("onboard.finalize.service.restarting"));
            await service.restart({
              env: process.env,
              stdout: process.stdout,
            });
          },
        );
      } else if (action === "reinstall") {
        await withWizardProgress(
          t("onboard.finalize.service.label"),
          { doneMessage: t("onboard.finalize.service.uninstalled") },
          async (progress) => {
            progress.update(t("onboard.finalize.service.uninstalling"));
            await service.uninstall({ env: process.env, stdout: process.stdout });
          },
        );
      }
    }

    if (!loaded || (loaded && !(await service.isLoaded({ env: process.env })))) {
      const progress = prompter.progress(t("onboard.finalize.service.label"));
      let installError: string | null = null;
      try {
        progress.update(t("onboard.finalize.service.preparing"));
        const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
          env: process.env,
          port: settings.port,
          token: settings.gatewayToken,
          runtime: daemonRuntime,
          warn: (message, title) => prompter.note(message, title),
          config: nextConfig,
        });

        progress.update(t("onboard.finalize.service.installing"));
        await service.install({
          env: process.env,
          stdout: process.stdout,
          programArguments,
          workingDirectory,
          environment,
        });
      } catch (err) {
        installError = err instanceof Error ? err.message : String(err);
      } finally {
        progress.stop(
          installError
            ? t("onboard.finalize.service.installFailed")
            : t("onboard.finalize.service.installed"),
        );
      }
      if (installError) {
        await prompter.note(
          t("onboard.finalize.service.installFailedDetail", { error: installError }),
          "Gateway",
        );
        await prompter.note(gatewayInstallErrorHint(), "Gateway");
      }
    }
  }

  if (!opts.skipHealth) {
    const probeLinks = resolveControlUiLinks({
      bind: nextConfig.gateway?.bind ?? "loopback",
      port: settings.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    // Daemon install/restart can briefly flap the WS; wait a bit so health check doesn't false-fail.
    await waitForGatewayReachable({
      url: probeLinks.wsUrl,
      token: settings.gatewayToken,
      deadlineMs: 15_000,
    });
    try {
      await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    } catch (err) {
      runtime.error(formatHealthCheckFailure(err));
      await prompter.note(
        t("onboard.finalize.healthCheck.docs"),
        t("onboard.finalize.healthCheck.label"),
      );
    }
  }

  const controlUiEnabled =
    nextConfig.gateway?.controlUi?.enabled ?? baseConfig.gateway?.controlUi?.enabled ?? true;
  if (!opts.skipUi && controlUiEnabled) {
    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }
  }

  await prompter.note(
    t("onboard.finalize.optionalApps.message"),
    t("onboard.finalize.optionalApps.label"),
  );

  const controlUiBasePath =
    nextConfig.gateway?.controlUi?.basePath ?? baseConfig.gateway?.controlUi?.basePath;
  const links = resolveControlUiLinks({
    bind: settings.bind,
    port: settings.port,
    customBindHost: settings.customBindHost,
    basePath: controlUiBasePath,
  });
  const tokenParam =
    settings.authMode === "token" && settings.gatewayToken
      ? `?token=${encodeURIComponent(settings.gatewayToken)}`
      : "";
  const authedUrl = `${links.httpUrl}${tokenParam}`;
  const gatewayProbe = await probeGatewayReachable({
    url: links.wsUrl,
    token: settings.authMode === "token" ? settings.gatewayToken : undefined,
    password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
  });
  const gatewayStatusLine = gatewayProbe.ok
    ? t("onboard.finalize.controlUi.gatewayReachable")
    : gatewayProbe.detail
      ? t("onboard.finalize.controlUi.gatewayNotDetectedDetail", { detail: gatewayProbe.detail })
      : t("onboard.finalize.controlUi.gatewayNotDetected");
  const bootstrapPath = path.join(
    resolveUserPath(options.workspaceDir),
    DEFAULT_BOOTSTRAP_FILENAME,
  );
  const hasBootstrap = await fs
    .access(bootstrapPath)
    .then(() => true)
    .catch(() => false);

  await prompter.note(
    [
      t("onboard.finalize.controlUi.webUi", { url: links.httpUrl }),
      tokenParam ? t("onboard.finalize.controlUi.webUiWithToken", { url: authedUrl }) : undefined,
      t("onboard.finalize.controlUi.gatewayWs", { url: links.wsUrl }),
      gatewayStatusLine,
      t("onboard.finalize.controlUi.docs"),
    ]
      .filter(Boolean)
      .join("\n"),
    t("onboard.finalize.controlUi.label"),
  );

  let controlUiOpened = false;
  let controlUiOpenHint: string | undefined;
  let seededInBackground = false;
  let hatchChoice: "tui" | "web" | "later" | null = null;

  if (!opts.skipUi && gatewayProbe.ok) {
    if (hasBootstrap) {
      await prompter.note(t("onboard.finalize.hatch.intro"), t("onboard.finalize.hatch.label"));
    }

    await prompter.note(
      t("onboard.finalize.token.info", {
        command: formatCliCommand("openclaw dashboard --no-open"),
      }),
      t("onboard.finalize.token.label"),
    );

    hatchChoice = await prompter.select({
      message: t("onboard.finalize.hatch.prompt"),
      options: [
        { value: "tui", label: t("onboard.finalize.hatch.tuiOption") },
        { value: "web", label: t("onboard.finalize.hatch.webOption") },
        { value: "later", label: t("onboard.finalize.hatch.laterOption") },
      ],
      initialValue: "tui",
    });

    if (hatchChoice === "tui") {
      await runTui({
        url: links.wsUrl,
        token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
        // Safety: onboarding TUI should not auto-deliver to lastProvider/lastTo.
        deliver: false,
        message: hasBootstrap ? t("onboard.finalize.hatch.wakeMessage") : undefined,
      });
      if (settings.authMode === "token" && settings.gatewayToken) {
        seededInBackground = await openUrlInBackground(authedUrl);
      }
      if (seededInBackground) {
        await prompter.note(
          t("onboard.finalize.webUi.seeded", {
            command: formatCliCommand("openclaw dashboard --no-open"),
          }),
          t("onboard.finalize.webUi.label"),
        );
      }
    } else if (hatchChoice === "web") {
      const browserSupport = await detectBrowserOpenSupport();
      if (browserSupport.ok) {
        controlUiOpened = await openUrl(authedUrl);
        if (!controlUiOpened) {
          controlUiOpenHint = formatControlUiSshHint({
            port: settings.port,
            basePath: controlUiBasePath,
            token: settings.gatewayToken,
          });
        }
      } else {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.gatewayToken,
        });
      }
      await prompter.note(
        [
          t("onboard.finalize.dashboard.linkWithToken", { url: authedUrl }),
          controlUiOpened
            ? t("onboard.finalize.dashboard.opened")
            : t("onboard.finalize.dashboard.copyPaste"),
          controlUiOpenHint,
        ]
          .filter(Boolean)
          .join("\n"),
        t("onboard.finalize.dashboard.label"),
      );
    } else {
      await prompter.note(
        t("onboard.finalize.later.message", {
          command: formatCliCommand("openclaw dashboard --no-open"),
        }),
        t("onboard.finalize.later.label"),
      );
    }
  } else if (opts.skipUi) {
    await prompter.note(
      t("onboard.finalize.controlUi.skipping"),
      t("onboard.finalize.controlUi.label"),
    );
  }

  await prompter.note(t("onboard.finalize.backup.message"), t("onboard.finalize.backup.label"));

  await prompter.note(t("onboard.finalize.security.message"), t("onboard.finalize.security.label"));

  const shouldOpenControlUi =
    !opts.skipUi &&
    settings.authMode === "token" &&
    Boolean(settings.gatewayToken) &&
    hatchChoice === null;
  if (shouldOpenControlUi) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      controlUiOpened = await openUrl(authedUrl);
      if (!controlUiOpened) {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.gatewayToken,
        });
      }
    } else {
      controlUiOpenHint = formatControlUiSshHint({
        port: settings.port,
        basePath: controlUiBasePath,
        token: settings.gatewayToken,
      });
    }

    await prompter.note(
      [
        t("onboard.finalize.dashboard.linkWithToken", { url: authedUrl }),
        controlUiOpened
          ? t("onboard.finalize.dashboard.opened")
          : t("onboard.finalize.dashboard.copyPaste"),
        controlUiOpenHint,
      ]
        .filter(Boolean)
        .join("\n"),
      t("onboard.finalize.dashboard.label"),
    );
  }

  const webSearchKey = (nextConfig.tools?.web?.search?.apiKey ?? "").trim();
  const webSearchEnv = (process.env.BRAVE_API_KEY ?? "").trim();
  const hasWebSearchKey = Boolean(webSearchKey || webSearchEnv);
  await prompter.note(
    hasWebSearchKey
      ? t("onboard.finalize.webSearch.enabled", {
          keySource: webSearchKey
            ? t("onboard.finalize.webSearch.keyInConfig")
            : t("onboard.finalize.webSearch.keyInEnv"),
        })
      : t("onboard.finalize.webSearch.disabled", {
          command: formatCliCommand("openclaw configure --section web"),
        }),
    t("onboard.finalize.webSearch.label"),
  );

  await prompter.note(t("onboard.finalize.whatNow.message"), t("onboard.finalize.whatNow.label"));

  await prompter.outro(
    controlUiOpened
      ? t("onboard.finalize.complete.withDashboard")
      : seededInBackground
        ? t("onboard.finalize.complete.withSeeded")
        : t("onboard.finalize.complete.default"),
  );
}
