import type { RuntimeEnv } from "../runtime.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { t } from "../i18n/index.js";
import { copyToClipboard } from "../infra/clipboard.js";
import { defaultRuntime } from "../runtime.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  resolveControlUiLinks,
} from "./onboard-helpers.js";

type DashboardOptions = {
  noOpen?: boolean;
};

export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardOptions = {},
) {
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? snapshot.config : {};
  const port = resolveGatewayPort(cfg);
  const bind = cfg.gateway?.bind ?? "loopback";
  const basePath = cfg.gateway?.controlUi?.basePath;
  const customBindHost = cfg.gateway?.customBindHost;

  const links = resolveControlUiLinks({
    port,
    bind,
    customBindHost,
    basePath,
  });
  const dashboardUrl = links.httpUrl;

  runtime.log(t("dashboard.url", { url: dashboardUrl }, `Dashboard URL: ${dashboardUrl}`));

  const copied = await copyToClipboard(dashboardUrl).catch(() => false);
  runtime.log(
    copied
      ? t("dashboard.copiedToClipboard", {}, "Copied to clipboard.")
      : t("dashboard.clipboardUnavailable", {}, "Copy to clipboard unavailable."),
  );

  let opened = false;
  let hint: string | undefined;
  if (!options.noOpen) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      opened = await openUrl(dashboardUrl);
    }
    if (!opened) {
      hint = formatControlUiSshHint({
        port,
        basePath,
      });
    }
  } else {
    hint = t(
      "dashboard.browserDisabled",
      {},
      "Browser launch disabled (--no-open). Use the URL above.",
    );
  }

  if (opened) {
    runtime.log(
      t(
        "dashboard.openedInBrowser",
        {},
        "Opened in your browser. Keep that tab to control OpenClaw.",
      ),
    );
  } else if (hint) {
    runtime.log(hint);
  }
}
