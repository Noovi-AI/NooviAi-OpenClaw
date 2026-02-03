// WAHA session status values
export type WahaSessionStatus = "STOPPED" | "STARTING" | "SCAN_QR_CODE" | "WORKING" | "FAILED";

// WAHA webhook event types (from WAHA docs)
export type WahaWebhookEvent =
  // Session events
  | "session.status"
  | "engine.event"
  // Message events
  | "message"
  | "message.any"
  | "message.ack"
  | "message.reaction"
  | "message.waiting"
  | "message.edited"
  | "message.revoked"
  // Group events
  | "group.v2.join"
  | "group.v2.leave"
  | "group.v2.participants"
  | "group.v2.update"
  // Other events
  | "chat.archive"
  | "presence.update"
  | "poll.vote"
  | "poll.vote.failed"
  | "label.upsert"
  | "label.deleted"
  | "label.chat.added"
  | "label.chat.deleted"
  | "call.received"
  | "call.accepted"
  | "call.rejected"
  | "event.response"
  | "event.response.failed";

// WAHA message types
export type WahaMessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "voice"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "poll"
  | "reaction"
  | "unknown";

// WAHA session info from API
export interface WahaSession {
  name: string;
  status: WahaSessionStatus;
  me?: {
    id: string;
    pushName?: string;
  };
  engine?: {
    engine: string;
    version?: string;
  };
  config?: {
    proxy?: string;
    webhooks?: WahaWebhookConfig[];
  };
}

export interface WahaWebhookConfig {
  url: string;
  events?: WahaWebhookEvent[];
  hmac?: {
    key: string;
  };
  retries?: {
    policy?: "constant" | "linear" | "exponential";
    delaySeconds?: number;
    attempts?: number;
  };
  customHeaders?: Array<{ name: string; value: string }>;
}

// WAHA webhook payload
export interface WahaWebhookPayload {
  event: WahaWebhookEvent;
  session: string;
  me?: {
    id: string;
    pushName?: string;
  };
  payload: WahaMessagePayload | WahaSessionStatusPayload | WahaReactionPayload;
  environment?: {
    version: string;
    engine: string;
    tier: string;
  };
}

export interface WahaMessagePayload {
  id: string;
  timestamp: number;
  from: string;
  to?: string;
  fromMe: boolean;
  body?: string;
  hasMedia: boolean;
  mediaUrl?: string;
  mimetype?: string;
  filename?: string;
  caption?: string;
  participant?: string; // Group sender
  isForwarded?: boolean;
  forwardingScore?: number;
  quotedMessage?: {
    id: string;
    body?: string;
  };
  mentionedIds?: string[];
  location?: {
    latitude: number;
    longitude: number;
    description?: string;
  };
  vcard?: string;
  poll?: {
    name: string;
    options: string[];
    allowMultiple: boolean;
  };
  _data?: {
    notifyName?: string;
    type?: string;
  };
}

export interface WahaSessionStatusPayload {
  name: string;
  status: WahaSessionStatus;
}

export interface WahaReactionPayload {
  id: string;
  from: string;
  to: string;
  fromMe: boolean;
  participant?: string;
  reaction: {
    text: string;
    messageId: string;
  };
}

// WAHA API send message responses
export interface WahaSendResult {
  id: string;
  timestamp?: number;
}

// WAHA QR code response
export interface WahaQrCodeResponse {
  value: string;
  mimetype: string;
}

// WAHA pairing code response
export interface WahaPairingCodeResponse {
  code: string;
}

// Configuration types
export interface WahaAccountConfig {
  enabled?: boolean;
  session: string;
  name?: string;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  mediaMaxMb?: number;
  webhookPath?: string;
}

export interface WahaConfig {
  enabled?: boolean;
  url: string;
  apiKey: string;
  session?: string;
  name?: string;
  webhookPath?: string;
  hmacKey?: string;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  mediaMaxMb?: number;
  accounts?: Record<string, WahaAccountConfig>;
}

export interface ResolvedWahaAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  url: string;
  apiKey: string;
  session: string;
  hmacKey?: string;
  config: WahaConfig & Partial<WahaAccountConfig>;
}

// Token source for status display
export type WahaCredentialSource = "config" | "none";

// Channel data for rich messages
export interface WahaChannelData {
  quickReplies?: string[];
  buttons?: Array<{
    id: string;
    text: string;
  }>;
  location?: {
    latitude: number;
    longitude: number;
    title?: string;
    address?: string;
  };
}
