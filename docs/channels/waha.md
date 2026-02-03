---
summary: "WAHA (WhatsApp HTTP API) integration: self-hosted or cloud, multi-session support"
read_when:
  - Working with WAHA channel behavior or configuration
title: "WAHA"
---

# WAHA (WhatsApp HTTP API)

Status: Requires a separate WAHA server (self-hosted or cloud).

## Quick setup

1. **Deploy a WAHA server** (self-hosted or cloud):
   ```bash
   docker run -d \
     --name waha \
     -p 3000:3000 \
     -e WHATSAPP_HOOK_URL="http://your-openclaw:18789/waha/webhook" \
     -e WHATSAPP_HOOK_HMAC_KEY="your-hmac-key" \
     -e WHATSAPP_HOOK_EVENTS="message,session.status" \
     ghcr.io/devlikeapro/waha:latest
   ```

2. Configure WAHA in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      waha: { enabled: true },
    },
  },
  channels: {
    waha: {
      enabled: true,
      url: "https://your-waha-server.com",
      apiKey: "your-waha-api-key",
      session: "default",
      dmPolicy: "pairing",
      webhookPath: "/waha/webhook",
    },
  },
}
```

3. **Login with QR code** (via CLI):
   ```bash
   openclaw channels login waha
   ```

4. Start the gateway.

## Goals

- Multi-session support (multiple WhatsApp accounts via WAHA sessions)
- Decoupled architecture (Gateway ↔ WAHA ↔ WhatsApp)
- Webhook-based message delivery
- Scalable deployments (multiple Gateway instances → single WAHA server)

## WAHA Server Setup

### Self-hosted (Docker)

```bash
docker run -d \
  --name waha \
  -p 3000:3000 \
  -v waha-data:/app/.sessions \
  -e WHATSAPP_HOOK_URL="http://your-openclaw:18789/waha/webhook" \
  -e WHATSAPP_HOOK_HMAC_KEY="your-hmac-key-secret" \
  -e WHATSAPP_HOOK_EVENTS="message,session.status" \
  -e WHATSAPP_HOOK_RETRY_POLICY="linear" \
  -e WHATSAPP_HOOK_RETRY_DELAY="5" \
  -e WHATSAPP_HOOK_RETRY_ATTEMPTS="5" \
  ghcr.io/devlikeapro/waha:latest
```

### Cloud Service

Use a managed WAHA cloud service:
- https://waha.devlike.pro/

Get your:
- Server URL (e.g., `https://connect.example.com`)
- API Key
- Session name

### Configuring Webhooks

WAHA needs to send messages to OpenClaw via webhooks. Configure in your WAHA server:

```bash
curl -X POST http://localhost:3000/api/sessions/default/webhooks \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your-waha-api-key" \
  -d '{
    "url": "http://your-openclaw:18789/waha/webhook",
    "events": ["message", "message.reaction", "message.edited", "session.status"],
    "hmac": {
      "key": "your-hmac-key-secret"
    },
    "retries": {
      "policy": "linear",
      "delaySeconds": 5,
      "attempts": 5
    }
  }'
```

## Config writes

WAHA is allowed to write config updates triggered by `/config set|unset` (requires `commands.config: true`).

Disable with:

```json5
{
  channels: { waha: { configWrites: false } },
}
```

## Multi-session Support

Configure multiple WhatsApp accounts:

```json5
{
  channels: {
    waha: {
      enabled: true,
      url: "https://your-waha-server.com",
      apiKey: "your-waha-api-key",
      dmPolicy: "pairing",
      // Account 1 (default)
      session: "personal",
      // Account 2
      accounts: {
        business: {
          enabled: true,
          session: "business",
          name: "Business Account",
          dmPolicy: "allowlist",
          allowFrom: ["5511999999999"],
        },
      },
    },
  },
}
```

## Login with QR Code

### CLI

```bash
# Start QR code flow
openclaw channels login waha

# Wait for scan (timeout: 60s default)
```

The CLI will:
1. Check if WAHA is configured
2. Create/start the session if needed
3. Display the QR code (or provide instructions to scan on the WAHA UI)
4. Wait for connection

### Web UI (Control UI)

Navigate to: `http://localhost:18789/waha/login`

## Security

### HMAC Webhook Validation

Configure HMAC key to verify webhook signatures:

```json5
{
  channels: {
    waha: {
      hmacKey: "your-hmac-key-secret",
      webhookPath: "/waha/webhook",
    },
  },
}
```

This key must match the `hmac.key` configured in WAHA webhooks.

### Allowlist & Pairing

**Pairing** (default): New contacts must be approved via `/pairing approve <code>`.

**Allowlist**: Only allow specific phone numbers:

```json5
{
  channels: {
    waha: {
      dmPolicy: "allowlist",
      allowFrom: ["5511999999999", "5511888888888"],
    },
  },
}
```

**Open** (not recommended for production):

```json5
{
  channels: {
    waha: {
      dmPolicy: "open",
    },
  },
}
```

## Group Behavior

Default: allowlist + require mention.

```json5
{
  channels: {
    waha: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["5511999999999@s.whatsapp.net"],
      groups: {
        "g_specific_group_id@g.us": {
          enabled: true,
          allowFrom: ["5511999999999@s.whatsapp.net"],
          requireMention: false,
          systemPrompt: "You are a helpful assistant in this group.",
        },
      },
    },
  },
}
```

## Troubleshooting

### Session not working

```bash
# Check session status
openclaw channels status --deep | grep waha

# Restart WAHA session (via WAHA API directly)
curl -X POST http://localhost:3000/api/sessions/default/start \
  -H "X-Api-Key: your-waha-api-key"
```

### Webhook not receiving messages

1. **Check WAHA webhook config**:
   ```bash
   curl http://localhost:3000/api/sessions/default/webhooks \
     -H "X-Api-Key: your-waha-api-key"
   ```

2. **Check OpenClaw logs**:
   ```bash
   openclaw logs --follow | grep waha
   ```

3. **Verify HMAC key matches** between OpenClaw and WAHA config.

### QR code not scanning

1. Ensure WAHA server is reachable from your phone (if scanning mobile UI)
2. Check session status: `openclaw channels status --deep`
3. Try restarting the session via WAHA API

### Connection timeout

Increase timeout in config:

```json5
{
  channels: {
    waha: {
      // Increase webhook timeout (default: 5s)
      mediaMaxMb: 10,
    },
  },
}
```

## Architecture

```
┌─────────────┐      HTTP/Webhook      ┌──────────────┐      Baileys      ┌──────────┐
│  OpenClaw   │ ◄─────────────────────► │   WAHA       │ ◄───────────────► │WhatsApp  │
│  Gateway    │                         │  (Docker)    │                  │  Cloud   │
└─────────────┘                         └──────────────┘                  └──────────┘
     channels.waha                          :3000
```

## WAHA vs Native WhatsApp

| Feature | WAHA (HTTP API) | Native WhatsApp (Baileys) |
|---------|-----------------|--------------------------|
| **Architecture** | Decoupled via HTTP | Direct connection |
| **Dependencies** | Requires WAHA server | Self-contained |
| **Scalability** | High (shared WAHA) | Per-process |
| **Multi-instance** | Yes (multiple Gateway → 1 WAHA) | No (each instance owns session) |
| **Latency** | Higher (HTTP hop) | Lower (direct) |
| **Setup complexity** | Higher (deploy WAHA) | Lower (QR only) |

## API Reference

### WAHA Client

The plugin uses `WahaClient` to communicate with WAHA API:

```typescript
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

// Get QR code
const qr = await client.getQrCodeDataUrl("default");
```

## Related Docs

- [Plugin System](/plugins) - How plugins work in OpenClaw
- [Security](/gateway/security) - Security policies for DMs and groups
- [Groups](/concepts/groups) - Group behavior across channels

## External Links

- [WAHA GitHub](https://github.com/devlikeapro/waha)
- [WAHA Cloud](https://waha.devlike.pro/)
- [WAHA Documentation](https://waha.devlike.pro/docs/)
