import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { wahaPlugin } from "./src/channel.js";
import { setWahaRuntime } from "./src/runtime.js";

const plugin = {
  id: "waha",
  name: "WAHA",
  description: "WAHA (WhatsApp HTTP API) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWahaRuntime(api.runtime);
    api.registerChannel({ plugin: wahaPlugin });
  },
};

export default plugin;
