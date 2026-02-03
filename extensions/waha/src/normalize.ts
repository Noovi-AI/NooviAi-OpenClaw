/**
 * Normalize E.164 phone number to WAHA chatId format.
 * E.164: +5511976819114 -> WAHA: 5511976819114@c.us
 */
export function e164ToChatId(e164: string): string {
  // Strip + and any non-digit characters
  const digits = e164.replace(/\D/g, "");
  if (!digits) {
    return e164;
  }
  return `${digits}@c.us`;
}

/**
 * Normalize WAHA chatId to E.164 format.
 * WAHA: 5511976819114@c.us -> E.164: +5511976819114
 */
export function chatIdToE164(chatId: string): string {
  // Extract digits before @c.us suffix
  const match = chatId.match(/^(\d+)@c\.us$/i);
  if (match) {
    return `+${match[1]}`;
  }
  // Already looks like E.164
  if (chatId.startsWith("+")) {
    return chatId;
  }
  // Just digits, add +
  const digits = chatId.replace(/\D/g, "");
  if (digits) {
    return `+${digits}`;
  }
  return chatId;
}

/**
 * Check if a chatId is a group.
 * Groups use @g.us suffix, newsletters use @newsletter
 */
export function isGroupChatId(chatId: string): boolean {
  return chatId.endsWith("@g.us") || chatId.endsWith("@newsletter");
}

/**
 * Check if a chatId is a direct message (individual user).
 */
export function isDirectChatId(chatId: string): boolean {
  return chatId.endsWith("@c.us");
}

/**
 * Normalize a target identifier to WAHA chatId format.
 * Handles various input formats:
 * - E.164: +5511976819114 -> 5511976819114@c.us
 * - Raw digits: 5511976819114 -> 5511976819114@c.us
 * - Already formatted: 5511976819114@c.us -> 5511976819114@c.us
 * - Group IDs: 123456789@g.us -> 123456789@g.us
 * - With prefix: waha:5511976819114 -> 5511976819114@c.us
 */
export function normalizeWahaTarget(target: string): string {
  const trimmed = target.trim();

  // Strip waha: prefix variants
  const stripped = trimmed.replace(/^waha:(?:user:|group:)?/i, "");

  // Already has WAHA suffix
  if (
    stripped.endsWith("@c.us") ||
    stripped.endsWith("@g.us") ||
    stripped.endsWith("@newsletter")
  ) {
    return stripped;
  }

  // Has E.164 plus sign
  if (stripped.startsWith("+")) {
    return e164ToChatId(stripped);
  }

  // Just digits - assume individual chat
  const digits = stripped.replace(/\D/g, "");
  if (digits && digits === stripped) {
    return `${digits}@c.us`;
  }

  // Return as-is if we can't parse it
  return stripped;
}

/**
 * Check if a string looks like a valid WAHA target ID.
 */
export function looksLikeWahaTargetId(target: string): boolean {
  const trimmed = target?.trim();
  if (!trimmed) {
    return false;
  }

  // Has WAHA suffix
  if (trimmed.endsWith("@c.us") || trimmed.endsWith("@g.us") || trimmed.endsWith("@newsletter")) {
    return true;
  }

  // Has waha: prefix
  if (/^waha:/i.test(trimmed)) {
    return true;
  }

  // E.164 format
  if (/^\+\d{10,15}$/.test(trimmed)) {
    return true;
  }

  // Raw phone number (10-15 digits)
  if (/^\d{10,15}$/.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Extract sender display info from webhook payload.
 */
export function formatSenderDisplay(chatId: string, pushName?: string): string {
  const e164 = chatIdToE164(chatId);
  if (pushName?.trim()) {
    return `${pushName} (${e164})`;
  }
  return e164;
}

/**
 * Normalize an allowFrom entry (phone number or chatId).
 */
export function normalizeWahaAllowEntry(entry: string): string {
  const trimmed = entry.trim();

  // Strip waha: prefix variants
  const stripped = trimmed.replace(/^waha:(?:user:|group:)?/i, "");

  // If it has @c.us suffix, extract the number
  const match = stripped.match(/^(\d+)@c\.us$/i);
  if (match) {
    return `+${match[1]}`;
  }

  // If it starts with +, keep as-is (E.164)
  if (stripped.startsWith("+")) {
    return stripped;
  }

  // If it's just digits, add +
  const digits = stripped.replace(/\D/g, "");
  if (digits && digits === stripped) {
    return `+${digits}`;
  }

  // Return as-is for group IDs etc
  return stripped;
}
