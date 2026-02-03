import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveGatewayPort } from "../config/config.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveNodeLaunchAgentLabel,
} from "../daemon/constants.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import {
  isLaunchAgentListed,
  isLaunchAgentLoaded,
  launchAgentPlistExists,
  repairLaunchAgentBootstrap,
} from "../daemon/launchd.js";
import { resolveGatewayService } from "../daemon/service.js";
import { renderSystemdUnavailableHints } from "../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { t } from "../i18n/index.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import { isWSL } from "../infra/wsl.js";
import { note } from "../terminal/note.js";
import { sleep } from "../utils.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "./daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { buildGatewayRuntimeHints, formatGatewayRuntimeSummary } from "./doctor-format.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommand } from "./health.js";

async function maybeRepairLaunchAgentBootstrap(params: {
  env: Record<string, string | undefined>;
  title: string;
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
}): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  const listed = await isLaunchAgentListed({ env: params.env });
  if (!listed) {
    return false;
  }

  const loaded = await isLaunchAgentLoaded({ env: params.env });
  if (loaded) {
    return false;
  }

  const plistExists = await launchAgentPlistExists(params.env);
  if (!plistExists) {
    return false;
  }

  note(
    t("doctor.daemon.launchAgentNotLoaded"),
    t("doctor.daemon.launchAgentLabel", { title: params.title }),
  );

  const shouldFix = await params.prompter.confirmSkipInNonInteractive({
    message: t("doctor.daemon.repairLaunchAgent", { title: params.title }),
    initialValue: true,
  });
  if (!shouldFix) {
    return false;
  }

  params.runtime.log(t("doctor.daemon.bootstrapping", { title: params.title }));
  const repair = await repairLaunchAgentBootstrap({ env: params.env });
  if (!repair.ok) {
    params.runtime.error(
      t("doctor.daemon.bootstrapFailed", {
        title: params.title,
        detail: repair.detail ?? "unknown error",
      }),
    );
    return false;
  }

  const verified = await isLaunchAgentLoaded({ env: params.env });
  if (!verified) {
    params.runtime.error(t("doctor.daemon.stillNotLoaded", { title: params.title }));
    return false;
  }

  note(
    t("doctor.daemon.repaired", { title: params.title }),
    t("doctor.daemon.launchAgentLabel", { title: params.title }),
  );
  return true;
}

export async function maybeRepairGatewayDaemon(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
  options: DoctorOptions;
  gatewayDetailsMessage: string;
  healthOk: boolean;
}) {
  if (params.healthOk) {
    return;
  }

  const service = resolveGatewayService();
  // systemd can throw in containers/WSL; treat as "not loaded" and fall back to hints.
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  let serviceRuntime: Awaited<ReturnType<typeof service.readRuntime>> | undefined;
  if (loaded) {
    serviceRuntime = await service.readRuntime(process.env).catch(() => undefined);
  }

  if (process.platform === "darwin" && params.cfg.gateway?.mode !== "remote") {
    const gatewayRepaired = await maybeRepairLaunchAgentBootstrap({
      env: process.env,
      title: "Gateway",
      runtime: params.runtime,
      prompter: params.prompter,
    });
    await maybeRepairLaunchAgentBootstrap({
      env: {
        ...process.env,
        OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
      },
      title: "Node",
      runtime: params.runtime,
      prompter: params.prompter,
    });
    if (gatewayRepaired) {
      loaded = await service.isLoaded({ env: process.env });
      if (loaded) {
        serviceRuntime = await service.readRuntime(process.env).catch(() => undefined);
      }
    }
  }

  if (params.cfg.gateway?.mode !== "remote") {
    const port = resolveGatewayPort(params.cfg, process.env);
    const diagnostics = await inspectPortUsage(port);
    if (diagnostics.status === "busy") {
      note(formatPortDiagnostics(diagnostics).join("\n"), t("doctor.daemon.portLabel"));
    } else if (loaded && serviceRuntime?.status === "running") {
      const lastError = await readLastGatewayErrorLine(process.env);
      if (lastError) {
        note(t("doctor.daemon.lastError", { error: lastError }), t("doctor.daemon.label"));
      }
    }
  }

  if (!loaded) {
    if (process.platform === "linux") {
      const systemdAvailable = await isSystemdUserServiceAvailable().catch(() => false);
      if (!systemdAvailable) {
        const wsl = await isWSL();
        note(renderSystemdUnavailableHints({ wsl }).join("\n"), t("doctor.daemon.label"));
        return;
      }
    }
    note(t("doctor.daemon.notInstalled"), t("doctor.daemon.label"));
    if (params.cfg.gateway?.mode !== "remote") {
      const install = await params.prompter.confirmSkipInNonInteractive({
        message: t("doctor.daemon.installNow"),
        initialValue: true,
      });
      if (install) {
        const daemonRuntime = await params.prompter.select<GatewayDaemonRuntime>(
          {
            message: t("doctor.daemon.runtimePrompt"),
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
          },
          DEFAULT_GATEWAY_DAEMON_RUNTIME,
        );
        const port = resolveGatewayPort(params.cfg, process.env);
        const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
          env: process.env,
          port,
          token: params.cfg.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN,
          runtime: daemonRuntime,
          warn: (message, title) => note(message, title),
          config: params.cfg,
        });
        try {
          await service.install({
            env: process.env,
            stdout: process.stdout,
            programArguments,
            workingDirectory,
            environment,
          });
        } catch (err) {
          note(t("doctor.daemon.installFailed", { error: String(err) }), t("doctor.daemon.label"));
          note(gatewayInstallErrorHint(), t("doctor.daemon.label"));
        }
      }
    }
    return;
  }

  const summary = formatGatewayRuntimeSummary(serviceRuntime);
  const hints = buildGatewayRuntimeHints(serviceRuntime, {
    platform: process.platform,
    env: process.env,
  });
  if (summary || hints.length > 0) {
    const lines: string[] = [];
    if (summary) {
      lines.push(t("doctor.daemon.runtimeSummary", { summary }));
    }
    lines.push(...hints);
    note(lines.join("\n"), t("doctor.daemon.label"));
  }

  if (serviceRuntime?.status !== "running") {
    const start = await params.prompter.confirmSkipInNonInteractive({
      message: t("doctor.daemon.startNow"),
      initialValue: true,
    });
    if (start) {
      await service.restart({
        env: process.env,
        stdout: process.stdout,
      });
      await sleep(1500);
    }
  }

  if (process.platform === "darwin") {
    const label = resolveGatewayLaunchAgentLabel(process.env.OPENCLAW_PROFILE);
    note(
      t("doctor.daemon.launchAgentStopNote", {
        command: formatCliCommand("openclaw gateway stop"),
        label,
      }),
      t("doctor.daemon.label"),
    );
  }

  if (serviceRuntime?.status === "running") {
    const restart = await params.prompter.confirmSkipInNonInteractive({
      message: t("doctor.daemon.restartNow"),
      initialValue: true,
    });
    if (restart) {
      await service.restart({
        env: process.env,
        stdout: process.stdout,
      });
      await sleep(1500);
      try {
        await healthCommand({ json: false, timeoutMs: 10_000 }, params.runtime);
      } catch (err) {
        const message = String(err);
        if (message.includes("gateway closed")) {
          note(t("doctor.daemon.notRunning"), t("doctor.daemon.label"));
          note(params.gatewayDetailsMessage, t("doctor.daemon.connectionLabel"));
        } else {
          params.runtime.error(formatHealthCheckFailure(err));
        }
      }
    }
  }
}
