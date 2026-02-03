import type {
  WahaSession,
  WahaSendResult,
  WahaQrCodeResponse,
  WahaPairingCodeResponse,
  WahaWebhookConfig,
} from "./types.js";

export interface WahaClientOptions {
  url: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface WahaFilePayload {
  url?: string;
  data?: string; // Base64
  mimetype?: string;
  filename?: string;
}

/**
 * WAHA HTTP API client.
 * See: https://waha.devlike.pro/docs/how-to/
 */
export class WahaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: WahaClientOptions) {
    // Ensure no trailing slash
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { rawResponse?: boolean },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "X-Api-Key": this.apiKey,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(`WAHA API error ${response.status}: ${errorText}`);
      }

      if (options?.rawResponse) {
        return response as unknown as T;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as T;
      }

      return (await response.text()) as unknown as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ========== Session Management ==========

  /**
   * List all sessions.
   * GET /api/sessions?all=true
   */
  async listSessions(includeAll = true): Promise<WahaSession[]> {
    const path = includeAll ? "/api/sessions?all=true" : "/api/sessions";
    return this.request<WahaSession[]>("GET", path);
  }

  /**
   * Get a specific session.
   * GET /api/sessions/{session}
   */
  async getSession(session: string): Promise<WahaSession> {
    return this.request<WahaSession>("GET", `/api/sessions/${encodeURIComponent(session)}`);
  }

  /**
   * Create a new session.
   * POST /api/sessions
   */
  async createSession(params: {
    name: string;
    start?: boolean;
    config?: {
      webhooks?: WahaWebhookConfig[];
      proxy?: string;
      debug?: boolean;
      metadata?: Record<string, string>;
    };
  }): Promise<WahaSession> {
    return this.request<WahaSession>("POST", "/api/sessions", params);
  }

  /**
   * Update session configuration.
   * PUT /api/sessions/{session}
   */
  async updateSession(
    session: string,
    config: {
      webhooks?: WahaWebhookConfig[];
      proxy?: string;
      debug?: boolean;
    },
  ): Promise<WahaSession> {
    return this.request<WahaSession>("PUT", `/api/sessions/${encodeURIComponent(session)}`, {
      config,
    });
  }

  /**
   * Start a session.
   * POST /api/sessions/{session}/start
   */
  async startSession(session: string): Promise<WahaSession> {
    return this.request<WahaSession>("POST", `/api/sessions/${encodeURIComponent(session)}/start`);
  }

  /**
   * Stop a session (without logging out).
   * POST /api/sessions/{session}/stop
   */
  async stopSession(session: string): Promise<void> {
    await this.request<void>("POST", `/api/sessions/${encodeURIComponent(session)}/stop`);
  }

  /**
   * Logout from a session.
   * POST /api/sessions/{session}/logout
   */
  async logoutSession(session: string): Promise<void> {
    await this.request<void>("POST", `/api/sessions/${encodeURIComponent(session)}/logout`);
  }

  /**
   * Delete a session entirely.
   * DELETE /api/sessions/{session}
   */
  async deleteSession(session: string): Promise<void> {
    await this.request<void>("DELETE", `/api/sessions/${encodeURIComponent(session)}`);
  }

  /**
   * Restart a session.
   * POST /api/sessions/{session}/restart
   */
  async restartSession(session: string): Promise<WahaSession> {
    return this.request<WahaSession>(
      "POST",
      `/api/sessions/${encodeURIComponent(session)}/restart`,
    );
  }

  // ========== Authentication ==========

  /**
   * Get QR code for authentication.
   * GET /api/{session}/auth/qr
   */
  async getQrCode(session: string, format: "image" | "raw" = "raw"): Promise<WahaQrCodeResponse> {
    const formatParam = format === "raw" ? "?format=raw" : "";
    return this.request<WahaQrCodeResponse>(
      "GET",
      `/api/${encodeURIComponent(session)}/auth/qr${formatParam}`,
    );
  }

  /**
   * Get QR code as base64 image data URL.
   */
  async getQrCodeDataUrl(session: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/${encodeURIComponent(session)}/auth/qr`, {
      headers: { "X-Api-Key": this.apiKey },
    });

    if (!response.ok) {
      throw new Error(`Failed to get QR code: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return `data:image/png;base64,${base64}`;
  }

  /**
   * Request pairing code for phone number authentication.
   * POST /api/{session}/auth/request-code
   */
  async requestPairingCode(session: string, phoneNumber: string): Promise<WahaPairingCodeResponse> {
    return this.request<WahaPairingCodeResponse>(
      "POST",
      `/api/${encodeURIComponent(session)}/auth/request-code`,
      { phoneNumber },
    );
  }

  /**
   * Get session "me" info (authenticated user).
   * GET /api/sessions/{session}/me
   */
  async getMe(session: string): Promise<{ id: string; pushName?: string } | null> {
    try {
      return await this.request<{ id: string; pushName?: string }>(
        "GET",
        `/api/sessions/${encodeURIComponent(session)}/me`,
      );
    } catch {
      return null;
    }
  }

  // ========== Messaging ==========

  /**
   * Send a text message.
   * POST /api/sendText
   */
  async sendText(params: {
    session: string;
    chatId: string;
    text: string;
    replyTo?: string;
    mentions?: string[];
    linkPreview?: boolean;
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>("POST", "/api/sendText", {
      session: params.session,
      chatId: params.chatId,
      text: params.text,
      reply_to: params.replyTo,
      mentions: params.mentions,
      linkPreview: params.linkPreview ?? true,
    });
  }

  /**
   * Send an image.
   * POST /api/sendImage
   */
  async sendImage(params: {
    session: string;
    chatId: string;
    file: WahaFilePayload;
    caption?: string;
    replyTo?: string;
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>("POST", "/api/sendImage", {
      session: params.session,
      chatId: params.chatId,
      file: params.file,
      caption: params.caption,
      reply_to: params.replyTo,
    });
  }

  /**
   * Send a video.
   * POST /api/sendVideo
   */
  async sendVideo(params: {
    session: string;
    chatId: string;
    file: WahaFilePayload;
    caption?: string;
    replyTo?: string;
    asNote?: boolean;
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>("POST", "/api/sendVideo", {
      session: params.session,
      chatId: params.chatId,
      file: params.file,
      caption: params.caption,
      reply_to: params.replyTo,
      asNote: params.asNote,
    });
  }

  /**
   * Send a voice message.
   * POST /api/sendVoice
   */
  async sendVoice(params: {
    session: string;
    chatId: string;
    file: WahaFilePayload;
    replyTo?: string;
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>("POST", "/api/sendVoice", {
      session: params.session,
      chatId: params.chatId,
      file: params.file,
      reply_to: params.replyTo,
    });
  }

  /**
   * Send a file/document.
   * POST /api/sendFile
   */
  async sendFile(params: {
    session: string;
    chatId: string;
    file: WahaFilePayload;
    caption?: string;
    replyTo?: string;
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>("POST", "/api/sendFile", {
      session: params.session,
      chatId: params.chatId,
      file: params.file,
      caption: params.caption,
      reply_to: params.replyTo,
    });
  }

  /**
   * Send a location.
   * POST /api/sendLocation
   */
  async sendLocation(params: {
    session: string;
    chatId: string;
    latitude: number;
    longitude: number;
    title?: string;
    address?: string;
    replyTo?: string;
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>("POST", "/api/sendLocation", {
      session: params.session,
      chatId: params.chatId,
      latitude: params.latitude,
      longitude: params.longitude,
      title: params.title,
      address: params.address,
      reply_to: params.replyTo,
    });
  }

  /**
   * Send a contact vCard.
   * POST /api/sendContactVcard
   */
  async sendContact(params: {
    session: string;
    chatId: string;
    vcard: string;
    replyTo?: string;
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>("POST", "/api/sendContactVcard", {
      session: params.session,
      chatId: params.chatId,
      vcard: params.vcard,
      reply_to: params.replyTo,
    });
  }

  /**
   * Send a poll.
   * POST /api/sendPoll
   */
  async sendPoll(params: {
    session: string;
    chatId: string;
    name: string;
    options: string[];
    allowMultiple?: boolean;
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>("POST", "/api/sendPoll", {
      session: params.session,
      chatId: params.chatId,
      name: params.name,
      options: params.options,
      allowMultipleAnswers: params.allowMultiple ?? false,
    });
  }

  /**
   * Send a reaction to a message.
   * POST /api/reaction
   */
  async sendReaction(params: {
    session: string;
    chatId: string;
    messageId: string;
    reaction: string; // Emoji or empty string to remove
  }): Promise<void> {
    await this.request<void>("POST", "/api/reaction", {
      session: params.session,
      messageId: params.messageId,
      reaction: params.reaction,
    });
  }

  /**
   * Mark messages as seen.
   * POST /api/sendSeen
   */
  async markSeen(params: {
    session: string;
    chatId: string;
    messageId?: string;
    participant?: string;
  }): Promise<void> {
    await this.request<void>("POST", "/api/sendSeen", {
      session: params.session,
      chatId: params.chatId,
      messageId: params.messageId,
      participant: params.participant,
    });
  }

  /**
   * Forward a message.
   * POST /api/forwardMessage
   */
  async forwardMessage(params: {
    session: string;
    chatId: string;
    messageId: string;
    to: string;
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>("POST", "/api/forwardMessage", {
      session: params.session,
      chatId: params.chatId,
      messageId: params.messageId,
      to: params.to,
    });
  }

  // ========== Media ==========

  /**
   * Download media from a message.
   * The mediaUrl in webhook payloads requires X-Api-Key header.
   */
  async downloadMedia(mediaUrl: string): Promise<Buffer> {
    const response = await fetch(mediaUrl, {
      headers: { "X-Api-Key": this.apiKey },
    });

    if (!response.ok) {
      throw new Error(`Failed to download media: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer);
  }

  // ========== Utility ==========

  /**
   * Check if the API is reachable and authenticated.
   */
  async ping(): Promise<boolean> {
    try {
      await this.listSessions(false);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create a WAHA client instance.
 */
export function createWahaClient(options: WahaClientOptions): WahaClient {
  return new WahaClient(options);
}
