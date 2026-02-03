import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import * as crypto from "node:crypto";
import { normalizePluginHttpPath, registerPluginHttpRoute } from "openclaw/plugin-sdk";
import type {
  WahaWebhookPayload,
  WahaMessagePayload,
  WahaReactionPayload,
  WahaSessionStatusPayload,
  ResolvedWahaAccount,
} from "./types.js";
import { getWahaRuntime } from "./runtime.js";

export interface WahaWebhookHandlerOptions {
  account: ResolvedWahaAccount;
  config: OpenClawConfig;
  webhookPath?: string;
  onMessage: (payload: WahaMessagePayload, session: string) => Promise<void>;
  onReaction?: (payload: WahaReactionPayload, session: string) => void;
  onSessionStatus?: (payload: WahaSessionStatusPayload, session: string) => void;
  log?: (msg: string) => void;
}

/**
 * Validate HMAC signature from WAHA webhook.
 * Header: X-Webhook-Hmac (SHA512 hash of request body)
 * Header: X-Webhook-Hmac-Algorithm (should be "sha512")
 */
export function validateWahaHmac(
  rawBody: string,
  signature: string,
  hmacKey: string,
  algorithm = "sha512",
): boolean {
  const computed = crypto.createHmac(algorithm, hmacKey).update(rawBody, "utf8").digest("hex");
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

/**
 * Read the raw request body from an IncomingMessage.
 */
async function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Register WAHA webhook handler.
 */
export function registerWahaWebhookHandler(opts: WahaWebhookHandlerOptions): () => void {
  const { account, webhookPath, onMessage, onReaction, onSessionStatus, log } = opts;
  const runtime = getWahaRuntime();
  const logFn = log ?? ((msg: string) => runtime.logging.shouldLogVerbose() && console.log(msg));

  // Normalize webhook path (e.g., /waha/webhook/accountId)
  const basePath = webhookPath ?? "/waha/webhook";
  const normalizedPath =
    normalizePluginHttpPath(basePath, "/waha/webhook") ?? `/waha/webhook/${account.accountId}`;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Handle GET requests for webhook verification
    if (req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("OK");
      return;
    }

    // Only accept POST requests
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, POST");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    try {
      const rawBody = await readRequestBody(req);

      // Validate HMAC if configured
      if (account.hmacKey) {
        const signature = req.headers["x-webhook-hmac"];
        const algorithm = (req.headers["x-webhook-hmac-algorithm"] as string) ?? "sha512";

        if (!signature || typeof signature !== "string") {
          logFn("waha: webhook missing X-Webhook-Hmac header");
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing HMAC signature" }));
          return;
        }

        if (!validateWahaHmac(rawBody, signature, account.hmacKey, algorithm)) {
          logFn("waha: webhook HMAC validation failed");
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid HMAC signature" }));
          return;
        }
      }

      // Parse webhook payload
      const payload = JSON.parse(rawBody) as WahaWebhookPayload;

      // Respond immediately with 200 to avoid WAHA timeout
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));

      // Process event asynchronously
      const { event, session } = payload;
      logFn(`waha: received webhook event "${event}" for session "${session}"`);

      switch (event) {
        case "message":
        case "message.any": {
          const msgPayload = payload.payload as WahaMessagePayload;
          // Skip messages from self
          if (!msgPayload.fromMe) {
            await onMessage(msgPayload, session).catch((err) => {
              runtime.logging
                .getChildLogger({ channel: "waha" })
                .error(`webhook message handler failed: ${String(err)}`);
            });
          }
          break;
        }

        case "message.reaction": {
          const reactionPayload = payload.payload as WahaReactionPayload;
          onReaction?.(reactionPayload, session);
          break;
        }

        case "session.status": {
          const statusPayload = payload.payload as WahaSessionStatusPayload;
          onSessionStatus?.(statusPayload, session);
          break;
        }

        default:
          logFn(`waha: ignoring unhandled event type "${event}"`);
      }
    } catch (err) {
      runtime.logging.getChildLogger({ channel: "waha" }).error(`webhook error: ${String(err)}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  };

  // Register the HTTP route
  const unregister = registerPluginHttpRoute({
    path: normalizedPath,
    pluginId: "waha",
    accountId: account.accountId,
    log: logFn,
    handler,
  });

  logFn(`waha: registered webhook handler at ${normalizedPath}`);

  return unregister;
}
