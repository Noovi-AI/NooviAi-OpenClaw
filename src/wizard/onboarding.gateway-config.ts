import type { GatewayAuthChoice } from "../commands/onboard-types.js";
import type { GatewayBindMode, GatewayTailscaleMode, OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type {
  GatewayWizardSettings,
  QuickstartGatewayDefaults,
  WizardFlow,
} from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";
import { normalizeGatewayTokenInput, randomToken } from "../commands/onboard-helpers.js";
import { t } from "../i18n/index.js";
import { findTailscaleBinary } from "../infra/tailscale.js";

type ConfigureGatewayOptions = {
  flow: WizardFlow;
  baseConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  localPort: number;
  quickstartGateway: QuickstartGatewayDefaults;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
};

type ConfigureGatewayResult = {
  nextConfig: OpenClawConfig;
  settings: GatewayWizardSettings;
};

export async function configureGatewayForOnboarding(
  opts: ConfigureGatewayOptions,
): Promise<ConfigureGatewayResult> {
  const { flow, localPort, quickstartGateway, prompter } = opts;
  let { nextConfig } = opts;

  const port =
    flow === "quickstart"
      ? quickstartGateway.port
      : Number.parseInt(
          String(
            await prompter.text({
              message: t("onboard.gatewayConfig.port.prompt"),
              initialValue: String(localPort),
              validate: (value) =>
                Number.isFinite(Number(value))
                  ? undefined
                  : t("onboard.gatewayConfig.port.invalid"),
            }),
          ),
          10,
        );

  let bind: GatewayWizardSettings["bind"] =
    flow === "quickstart"
      ? quickstartGateway.bind
      : await prompter.select<GatewayWizardSettings["bind"]>({
          message: t("onboard.gatewayConfig.bind.prompt"),
          options: [
            { value: "loopback", label: t("onboard.gatewayConfig.bind.loopback") },
            { value: "lan", label: t("onboard.gatewayConfig.bind.lan") },
            { value: "tailnet", label: t("onboard.gatewayConfig.bind.tailnet") },
            { value: "auto", label: t("onboard.gatewayConfig.bind.auto") },
            { value: "custom", label: t("onboard.gatewayConfig.bind.custom") },
          ],
        });

  let customBindHost = quickstartGateway.customBindHost;
  if (bind === "custom") {
    const needsPrompt = flow !== "quickstart" || !customBindHost;
    if (needsPrompt) {
      const input = await prompter.text({
        message: t("onboard.gatewayConfig.customIp.prompt"),
        placeholder: t("onboard.gatewayConfig.customIp.placeholder"),
        initialValue: customBindHost ?? "",
        validate: (value) => {
          if (!value) {
            return t("onboard.gatewayConfig.customIp.required");
          }
          const trimmed = value.trim();
          const parts = trimmed.split(".");
          if (parts.length !== 4) {
            return t("onboard.gatewayConfig.customIp.invalidFormat");
          }
          if (
            parts.every((part) => {
              const n = parseInt(part, 10);
              return !Number.isNaN(n) && n >= 0 && n <= 255 && part === String(n);
            })
          ) {
            return undefined;
          }
          return t("onboard.gatewayConfig.customIp.invalidOctet");
        },
      });
      customBindHost = typeof input === "string" ? input.trim() : undefined;
    }
  }

  let authMode =
    flow === "quickstart"
      ? quickstartGateway.authMode
      : ((await prompter.select({
          message: t("onboard.gatewayConfig.auth.prompt"),
          options: [
            {
              value: "token",
              label: t("onboard.gatewayConfig.auth.token"),
              hint: t("onboard.gatewayConfig.auth.tokenHint"),
            },
            { value: "password", label: t("onboard.gatewayConfig.auth.password") },
          ],
          initialValue: "token",
        })) as GatewayAuthChoice);

  const tailscaleMode: GatewayWizardSettings["tailscaleMode"] =
    flow === "quickstart"
      ? quickstartGateway.tailscaleMode
      : await prompter.select<GatewayWizardSettings["tailscaleMode"]>({
          message: t("onboard.gatewayConfig.tailscale.prompt"),
          options: [
            {
              value: "off",
              label: t("onboard.gatewayConfig.tailscale.off"),
              hint: t("onboard.gatewayConfig.tailscale.offHint"),
            },
            {
              value: "serve",
              label: t("onboard.gatewayConfig.tailscale.serve"),
              hint: t("onboard.gatewayConfig.tailscale.serveHint"),
            },
            {
              value: "funnel",
              label: t("onboard.gatewayConfig.tailscale.funnel"),
              hint: t("onboard.gatewayConfig.tailscale.funnelHint"),
            },
          ],
        });

  // Detect Tailscale binary before proceeding with serve/funnel setup.
  if (tailscaleMode !== "off") {
    const tailscaleBin = await findTailscaleBinary();
    if (!tailscaleBin) {
      await prompter.note(
        t("onboard.gatewayConfig.tailscale.binaryNotFound"),
        t("onboard.gatewayConfig.tailscale.warningLabel"),
      );
    }
  }

  let tailscaleResetOnExit = flow === "quickstart" ? quickstartGateway.tailscaleResetOnExit : false;
  if (tailscaleMode !== "off" && flow !== "quickstart") {
    await prompter.note(
      t("onboard.gatewayConfig.tailscale.docs"),
      t("onboard.gatewayConfig.tailscale.docsLabel"),
    );
    tailscaleResetOnExit = Boolean(
      await prompter.confirm({
        message: t("onboard.gatewayConfig.tailscale.resetPrompt"),
        initialValue: false,
      }),
    );
  }

  // Safety + constraints:
  // - Tailscale wants bind=loopback so we never expose a non-loopback server + tailscale serve/funnel at once.
  // - Funnel requires password auth.
  if (tailscaleMode !== "off" && bind !== "loopback") {
    await prompter.note(
      t("onboard.gatewayConfig.tailscale.requiresLoopback"),
      t("onboard.gatewayConfig.tailscale.noteLabel"),
    );
    bind = "loopback";
    customBindHost = undefined;
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    await prompter.note(
      t("onboard.gatewayConfig.tailscale.funnelRequiresPassword"),
      t("onboard.gatewayConfig.tailscale.noteLabel"),
    );
    authMode = "password";
  }

  let gatewayToken: string | undefined;
  if (authMode === "token") {
    if (flow === "quickstart") {
      gatewayToken = quickstartGateway.token ?? randomToken();
    } else {
      const tokenInput = await prompter.text({
        message: t("onboard.gatewayConfig.token.prompt"),
        placeholder: t("onboard.gatewayConfig.token.placeholder"),
        initialValue: quickstartGateway.token ?? "",
      });
      gatewayToken = normalizeGatewayTokenInput(tokenInput) || randomToken();
    }
  }

  if (authMode === "password") {
    const password =
      flow === "quickstart" && quickstartGateway.password
        ? quickstartGateway.password
        : await prompter.text({
            message: t("onboard.gatewayConfig.password.prompt"),
            validate: (value) =>
              value?.trim() ? undefined : t("onboard.gatewayConfig.password.required"),
          });
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "password",
          password: String(password).trim(),
        },
      },
    };
  } else if (authMode === "token") {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "token",
          token: gatewayToken,
        },
      },
    };
  }

  nextConfig = {
    ...nextConfig,
    gateway: {
      ...nextConfig.gateway,
      port,
      bind: bind as GatewayBindMode,
      ...(bind === "custom" && customBindHost ? { customBindHost } : {}),
      tailscale: {
        ...nextConfig.gateway?.tailscale,
        mode: tailscaleMode as GatewayTailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  return {
    nextConfig,
    settings: {
      port,
      bind: bind as GatewayBindMode,
      customBindHost: bind === "custom" ? customBindHost : undefined,
      authMode,
      gatewayToken,
      tailscaleMode: tailscaleMode as GatewayTailscaleMode,
      tailscaleResetOnExit,
    },
  };
}
