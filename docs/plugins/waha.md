---
summary: "WAHA (WhatsApp HTTP API) plugin documentation"
read_when:
  - Installing or configuring the WAHA plugin
title: "WAHA Plugin"
---

# WAHA Plugin

The WAHA plugin provides WhatsApp integration via the WAHA (WhatsApp HTTP API) service.

## Overview

WAHA is a self-hosted HTTP API for WhatsApp that runs as a separate service. OpenClaw connects to WAHA via HTTP/webhooks, which then connects to WhatsApp using Baileys.

**Use WAHA when:**

- You need multi-instance support (multiple Gateway instances → single WAHA server)
- You want decoupled architecture (Gateway and WhatsApp connection are separate)
- You need centralized session management
- You're already running WAHA for other applications

**Use native WhatsApp when:**

- You want the simplest setup (single instance, no external dependencies)
- You need lower latency (direct connection)
- You're running a single Gateway instance

## Installation

The WAHA plugin is bundled with NooviAI OpenClaw. No installation needed.

Enable in config:

```bash
openclaw config set plugins.entries.waha.enabled true
```

Or edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "waha": { "enabled": true }
    }
  }
}
```

## Configuration

See [WAHA Channel](/channels/waha) for full configuration details.

Minimal config:

```json
{
  "plugins": {
    "entries": {
      "waha": { "enabled": true }
    }
  },
  "channels": {
    "waha": {
      "enabled": true,
      "url": "https://your-waha-server.com",
      "apiKey": "your-waha-api-key",
      "session": "default",
      "dmPolicy": "pairing"
    }
  }
}
```

## Plugin Structure

```typescript
// extensions/waha/index.ts
export default {
  id: "waha",
  name: "WAHA",
  description: "WAHA (WhatsApp HTTP API) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: wahaPlugin });
  },
};
```

## Channel Plugin

The plugin registers a channel plugin with the following features:

### Capabilities

- **Chat types**: direct, group
- **Polls**: ✅
- **Reactions**: ✅
- **Media**: ✅ (images, videos, documents)
- **Native commands**: ❌
- **Streaming**: ✅ (multiple messages supported)

### Gateway Methods

- `startAccount` - Start monitoring a WAHA session
- `loginWithQrStart` - Begin QR code login flow
- `loginWithQrWait` - Wait for QR code scan completion
- `logoutAccount` - Logout and clear session config

### Status Probe

The plugin includes a health check that:

1. Connects to WAHA API
2. Gets session status
3. Returns session info if `status === "WORKING"`

## WAHA Client

The plugin includes a TypeScript HTTP client for WAHA API:

```typescript
import { WahaClient } from "./api-client.js";

const client = new WahaClient({
  url: "https://your-waha-server.com",
  apiKey: "your-api-key",
  timeoutMs: 30000,
});

// Get session
const session = await client.getSession("default");

// Send message
await client.sendText({
  session: "default",
  chatId: "5511999999999@s.whatsapp.net",
  text: "Hello!",
});

// Send media
await client.sendImage({
  session: "default",
  chatId: "5511999999999@s.whatsapp.net",
  file: { url: "https://example.com/image.jpg" },
  caption: "Look at this!",
});

// Get QR code
const qr = await client.getQrCodeDataUrl("default");
console.log(qr.value); // Data URL for QR image
```

## Webhook Handler

The plugin handles inbound messages from WAHA webhooks:

```typescript
// Supported webhook events:
-"message" - // New message
  "message.ack" - // Message acknowledgment
  "message.reaction" - // Reaction to message
  "message.edited" - // Edited message
  "session.status" - // Session status changes
  "group.v2.join" - // User joined group
  "group.v2.leave" - // User left group
  "poll.vote"; // Poll vote
```

Webhook endpoint: `http://your-openclaw:18789/waha/webhook`

Configure in WAHA:

```bash
curl -X POST http://localhost:3000/api/sessions/default/webhooks \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your-waha-api-key" \
  -d '{
    "url": "http://your-openclaw:18789/waha/webhook",
    "events": ["message", "message.reaction", "session.status"],
    "hmac": { "key": "your-hmac-key" }
  }'
```

## Monitoring

The plugin monitors WAHA sessions in real-time:

```typescript
// Auto-reconnect on session disconnect
// Track last inbound/outbound timestamps
// Log session status changes
```

Monitor logs:

```bash
openclaw logs --follow | grep waha
```

## Multi-Account Support

Configure multiple WAHA sessions (each = one WhatsApp account):

```json
{
  "channels": {
    "waha": {
      "enabled": true,
      "url": "https://your-waha-server.com",
      "apiKey": "your-waha-api-key",
      // Default account
      "session": "personal",
      // Additional accounts
      "accounts": {
        "business": {
          "enabled": true,
          "session": "business",
          "name": "Business Account",
          "dmPolicy": "allowlist",
          "allowFrom": ["5511999999999"]
        },
        "support": {
          "enabled": true,
          "session": "support",
          "name": "Support Bot",
          "dmPolicy": "pairing"
        }
      }
    }
  }
}
```

## Development

### Project Structure

```
extensions/waha/
├── index.ts                  # Plugin entry point
├── package.json              # Package metadata
├── openclaw.plugin.json      # Plugin manifest
└── src/
    ├── api-client.ts         # WAHA HTTP client
    ├── monitor.ts            # Session monitor
    ├── webhook-handler.ts    # Webhook handler
    ├── accounts.ts           # Account resolution
    ├── config-schema.ts      # Config validation
    ├── types.ts              # TypeScript types
    ├── channel.ts            # Channel plugin
    ├── runtime.ts            # Runtime helpers
    └── normalize.ts          # ID normalization
```

### Building

```bash
cd extensions/waha
pnpm install
```

### Testing

The plugin doesn't have live tests yet (requires WAHA server integration).

## Troubleshooting

### Plugin not loading

```bash
# Check plugin status
openclaw plugins list | grep waha

# Check plugin diagnostics
openclaw plugins list --diagnostics
```

### Session not connecting

1. Verify WAHA server is running:

   ```bash
   curl http://localhost:3000/api/sessions
   ```

2. Check WAHA logs:

   ```bash
   docker logs waha
   ```

3. Verify webhook is configured in WAHA

### Webhook not receiving messages

1. Check OpenClaw is listening:

   ```bash
   curl http://localhost:18789/waha/webhook
   ```

2. Check WAHA webhook config:

   ```bash
   curl http://localhost:3000/api/sessions/default/webhooks \
     -H "X-Api-Key: your-waha-api-key"
   ```

3. Check firewall/network rules

## Related Docs

- [WAHA Channel](/channels/waha) - Channel configuration and usage
- [Channel Plugins](/plugins) - Plugin system overview
- [Security](/gateway/security) - Security policies

## External Links

- [WAHA GitHub](https://github.com/devlikeapro/waha)
- [WAHA Documentation](https://waha.devlike.pro/docs/)
- [WAHA Cloud](https://waha.devlike.pro/)
