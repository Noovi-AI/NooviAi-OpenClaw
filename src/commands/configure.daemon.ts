import type { RuntimeEnv } from "../runtime.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import { t } from "../i18n/index.js";
import { note } from "../terminal/note.js";
import { confirm, select } from "./configure.shared.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "./daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { guardCancel } from "./onboard-helpers.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

export async function maybeInstallDaemon(params: {
  runtime: RuntimeEnv;
  port: number;
  gatewayToken?: string;
  daemonRuntime?: GatewayDaemonRuntime;
}) {
  const service = resolveGatewayService();
  const loaded = await service.isLoaded({ env: process.env });
  let shouldCheckLinger = false;
  let shouldInstall = true;
  let daemonRuntime = params.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (loaded) {
    const action = guardCancel(
      await select({
        message: t("configure.daemon.alreadyInstalled"),
        options: [
          { value: "restart", label: t("configure.daemon.restart") },
          { value: "reinstall", label: t("configure.daemon.reinstall") },
          { value: "skip", label: t("configure.daemon.skip") },
        ],
      }),
      params.runtime,
    );
    if (action === "restart") {
      await withProgress(
        { label: t("configure.daemon.serviceLabel"), indeterminate: true, delayMs: 0 },
        async (progress) => {
          progress.setLabel(t("configure.daemon.restarting"));
          await service.restart({
            env: process.env,
            stdout: process.stdout,
          });
          progress.setLabel(t("configure.daemon.restarted"));
        },
      );
      shouldCheckLinger = true;
      shouldInstall = false;
    }
    if (action === "skip") {
      return;
    }
    if (action === "reinstall") {
      await withProgress(
        { label: t("configure.daemon.serviceLabel"), indeterminate: true, delayMs: 0 },
        async (progress) => {
          progress.setLabel(t("configure.daemon.uninstalling"));
          await service.uninstall({ env: process.env, stdout: process.stdout });
          progress.setLabel(t("configure.daemon.uninstalled"));
        },
      );
    }
  }

  if (shouldInstall) {
    let installError: string | null = null;
    if (!params.daemonRuntime) {
      if (GATEWAY_DAEMON_RUNTIME_OPTIONS.length === 1) {
        daemonRuntime = GATEWAY_DAEMON_RUNTIME_OPTIONS[0]?.value ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
      } else {
        daemonRuntime = guardCancel(
          await select({
            message: t("configure.daemon.runtimePrompt"),
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
          }),
          params.runtime,
        ) as GatewayDaemonRuntime;
      }
    }
    await withProgress(
      { label: t("configure.daemon.serviceLabel"), indeterminate: true, delayMs: 0 },
      async (progress) => {
        progress.setLabel(t("configure.daemon.preparing"));

        const cfg = loadConfig();
        const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
          env: process.env,
          port: params.port,
          token: params.gatewayToken,
          runtime: daemonRuntime,
          warn: (message, title) => note(message, title),
          config: cfg,
        });

        progress.setLabel(t("configure.daemon.installing"));
        try {
          await service.install({
            env: process.env,
            stdout: process.stdout,
            programArguments,
            workingDirectory,
            environment,
          });
          progress.setLabel(t("configure.daemon.installed"));
        } catch (err) {
          installError = err instanceof Error ? err.message : String(err);
          progress.setLabel(t("configure.daemon.installFailed"));
        }
      },
    );
    if (installError) {
      note(
        t("configure.daemon.installFailedDetail", { error: installError }),
        t("configure.daemon.gatewayLabel"),
      );
      note(gatewayInstallErrorHint(), t("configure.daemon.gatewayLabel"));
      return;
    }
    shouldCheckLinger = true;
  }

  if (shouldCheckLinger) {
    await ensureSystemdUserLingerInteractive({
      runtime: params.runtime,
      prompter: {
        confirm: async (p) => guardCancel(await confirm(p), params.runtime),
        note,
      },
      reason: t("configure.daemon.lingerReason"),
      requireConfirm: true,
    });
  }
}
