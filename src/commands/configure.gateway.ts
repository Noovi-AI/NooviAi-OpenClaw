import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveGatewayPort } from "../config/config.js";
import { t } from "../i18n/index.js";
import { findTailscaleBinary } from "../infra/tailscale.js";
import { note } from "../terminal/note.js";
import { buildGatewayAuthConfig } from "./configure.gateway-auth.js";
import { confirm, select, text } from "./configure.shared.js";
import { guardCancel, normalizeGatewayTokenInput, randomToken } from "./onboard-helpers.js";

type GatewayAuthChoice = "token" | "password";

export async function promptGatewayConfig(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<{
  config: OpenClawConfig;
  port: number;
  token?: string;
}> {
  const portRaw = guardCancel(
    await text({
      message: t("configure.gateway.portPrompt"),
      initialValue: String(resolveGatewayPort(cfg)),
      validate: (value) =>
        Number.isFinite(Number(value)) ? undefined : t("configure.gateway.portInvalid"),
    }),
    runtime,
  );
  const port = Number.parseInt(String(portRaw), 10);

  let bind = guardCancel(
    await select({
      message: t("configure.gateway.bindPrompt"),
      options: [
        {
          value: "loopback",
          label: t("configure.gateway.bindLoopback"),
          hint: t("configure.gateway.bindLoopbackHint"),
        },
        {
          value: "tailnet",
          label: t("configure.gateway.bindTailnet"),
          hint: t("configure.gateway.bindTailnetHint"),
        },
        {
          value: "auto",
          label: t("configure.gateway.bindAuto"),
          hint: t("configure.gateway.bindAutoHint"),
        },
        {
          value: "lan",
          label: t("configure.gateway.bindLan"),
          hint: t("configure.gateway.bindLanHint"),
        },
        {
          value: "custom",
          label: t("configure.gateway.bindCustom"),
          hint: t("configure.gateway.bindCustomHint"),
        },
      ],
    }),
    runtime,
  );

  let customBindHost: string | undefined;
  if (bind === "custom") {
    const input = guardCancel(
      await text({
        message: t("configure.gateway.customIpPrompt"),
        placeholder: t("configure.gateway.customIpPlaceholder"),
        validate: (value) => {
          if (!value) {
            return t("configure.gateway.customIpRequired");
          }
          const trimmed = value.trim();
          const parts = trimmed.split(".");
          if (parts.length !== 4) {
            return t("configure.gateway.customIpInvalidFormat");
          }
          if (
            parts.every((part) => {
              const n = parseInt(part, 10);
              return !Number.isNaN(n) && n >= 0 && n <= 255 && part === String(n);
            })
          ) {
            return undefined;
          }
          return t("configure.gateway.customIpInvalidOctet");
        },
      }),
      runtime,
    );
    customBindHost = typeof input === "string" ? input : undefined;
  }

  let authMode = guardCancel(
    await select({
      message: t("configure.gateway.authPrompt"),
      options: [
        {
          value: "token",
          label: t("configure.gateway.authToken"),
          hint: t("configure.gateway.authTokenHint"),
        },
        { value: "password", label: t("configure.gateway.authPassword") },
      ],
      initialValue: "token",
    }),
    runtime,
  ) as GatewayAuthChoice;

  const tailscaleMode = guardCancel(
    await select({
      message: t("configure.gateway.tailscalePrompt"),
      options: [
        {
          value: "off",
          label: t("configure.gateway.tailscaleOff"),
          hint: t("configure.gateway.tailscaleOffHint"),
        },
        {
          value: "serve",
          label: t("configure.gateway.tailscaleServe"),
          hint: t("configure.gateway.tailscaleServeHint"),
        },
        {
          value: "funnel",
          label: t("configure.gateway.tailscaleFunnel"),
          hint: t("configure.gateway.tailscaleFunnelHint"),
        },
      ],
    }),
    runtime,
  );

  // Detect Tailscale binary before proceeding with serve/funnel setup.
  if (tailscaleMode !== "off") {
    const tailscaleBin = await findTailscaleBinary();
    if (!tailscaleBin) {
      note(
        t("configure.gateway.tailscaleBinaryNotFound"),
        t("configure.gateway.tailscaleWarningLabel"),
      );
    }
  }

  let tailscaleResetOnExit = false;
  if (tailscaleMode !== "off") {
    note(t("configure.gateway.tailscaleDocs"), t("configure.gateway.tailscaleDocsLabel"));
    tailscaleResetOnExit = Boolean(
      guardCancel(
        await confirm({
          message: t("configure.gateway.tailscaleResetPrompt"),
          initialValue: false,
        }),
        runtime,
      ),
    );
  }

  if (tailscaleMode !== "off" && bind !== "loopback") {
    note(t("configure.gateway.tailscaleRequiresLoopback"), t("configure.gateway.noteLabel"));
    bind = "loopback";
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    note(t("configure.gateway.tailscaleFunnelRequiresPassword"), t("configure.gateway.noteLabel"));
    authMode = "password";
  }

  let gatewayToken: string | undefined;
  let gatewayPassword: string | undefined;
  let next = cfg;

  if (authMode === "token") {
    const tokenInput = guardCancel(
      await text({
        message: t("configure.gateway.tokenPrompt"),
        initialValue: randomToken(),
      }),
      runtime,
    );
    gatewayToken = normalizeGatewayTokenInput(tokenInput) || randomToken();
  }

  if (authMode === "password") {
    const password = guardCancel(
      await text({
        message: t("configure.gateway.passwordPrompt"),
        validate: (value) => (value?.trim() ? undefined : t("configure.gateway.passwordRequired")),
      }),
      runtime,
    );
    gatewayPassword = String(password).trim();
  }

  const authConfig = buildGatewayAuthConfig({
    existing: next.gateway?.auth,
    mode: authMode,
    token: gatewayToken,
    password: gatewayPassword,
  });

  next = {
    ...next,
    gateway: {
      ...next.gateway,
      mode: "local",
      port,
      bind,
      auth: authConfig,
      ...(customBindHost && { customBindHost }),
      tailscale: {
        ...next.gateway?.tailscale,
        mode: tailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  return { config: next, port, token: gatewayToken };
}
