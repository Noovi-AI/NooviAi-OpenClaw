/**
 * OpenClaw Web UI Internationalization (i18n) Module
 *
 * Provides translation support for the web UI.
 *
 * Usage:
 *   import { t, initI18n, getLocale, setLocale } from "../i18n";
 *
 *   // Initialize at app startup
 *   await initI18n();
 *
 *   // Or initialize with explicit locale
 *   await initI18n("pt");
 *
 *   // Use translations
 *   console.log(t("nav.chat")); // => "Chat"
 *
 *   // With interpolation
 *   console.log(t("status.connected", { url: "ws://localhost:18789" }));
 */

import type { FlatTranslationDict, Locale, TranslationParams } from "./types.js";
import enTranslations from "./locales/en.js";
import ptTranslations from "./locales/pt.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./types.js";

// Module state
let currentLocale: Locale = DEFAULT_LOCALE;
let translations: Map<Locale, FlatTranslationDict> = new Map();
let initialized = false;

// Event listeners for locale changes
const localeChangeListeners: Set<(locale: Locale) => void> = new Set();

/**
 * Flatten a nested translation dictionary into dot-notation keys
 */
function flattenDict(dict: Record<string, unknown>, prefix = ""): FlatTranslationDict {
  const result: FlatTranslationDict = {};

  for (const [key, value] of Object.entries(dict)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "string") {
      result[fullKey] = value;
    } else if (typeof value === "object" && value !== null) {
      Object.assign(result, flattenDict(value as Record<string, unknown>, fullKey));
    }
  }

  return result;
}

/**
 * Detect browser locale
 */
function detectBrowserLocale(): Locale {
  // Check localStorage first
  const stored = localStorage.getItem("openclaw-language");
  if (stored && SUPPORTED_LOCALES.includes(stored as Locale)) {
    return stored as Locale;
  }

  // Check browser language
  const browserLang = navigator.language.toLowerCase();

  // Check for exact match
  if (SUPPORTED_LOCALES.includes(browserLang as Locale)) {
    return browserLang as Locale;
  }

  // Check for language prefix (e.g., "pt-BR" -> "pt")
  const langPrefix = browserLang.split("-")[0];
  if (SUPPORTED_LOCALES.includes(langPrefix as Locale)) {
    return langPrefix as Locale;
  }

  return DEFAULT_LOCALE;
}

/**
 * Normalize a locale string
 */
function normalizeLocale(locale: string | undefined): Locale {
  if (!locale) {
    return DEFAULT_LOCALE;
  }

  const normalized = locale.toLowerCase().trim();

  // Direct match
  if (SUPPORTED_LOCALES.includes(normalized as Locale)) {
    return normalized as Locale;
  }

  // Language prefix match
  const langPrefix = normalized.split(/[-_]/)[0];
  if (SUPPORTED_LOCALES.includes(langPrefix as Locale)) {
    return langPrefix as Locale;
  }

  return DEFAULT_LOCALE;
}

/**
 * Initialize the i18n system
 *
 * @param locale - Explicit locale to use (overrides auto-detection)
 */
export async function initI18n(locale?: string): Promise<void> {
  // Load translations
  translations.set("en", flattenDict(enTranslations));
  translations.set("pt", flattenDict(ptTranslations));

  // Determine locale
  if (locale) {
    currentLocale = normalizeLocale(locale);
  } else {
    currentLocale = detectBrowserLocale();
  }

  initialized = true;
}

/**
 * Get the current locale
 */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Set the current locale and persist to localStorage
 */
export function setLocale(locale: string): void {
  const normalized = normalizeLocale(locale);
  if (normalized === currentLocale) {
    return;
  }

  currentLocale = normalized;
  localStorage.setItem("openclaw-language", normalized);

  // Notify listeners
  for (const listener of localeChangeListeners) {
    listener(normalized);
  }
}

/**
 * Subscribe to locale changes
 */
export function onLocaleChange(callback: (locale: Locale) => void): () => void {
  localeChangeListeners.add(callback);
  return () => localeChangeListeners.delete(callback);
}

/**
 * Check if i18n is initialized
 */
export function isInitialized(): boolean {
  return initialized;
}

/**
 * Interpolate variables in a translation string
 *
 * Supports {{variable}} syntax
 */
function interpolate(template: string, params?: TranslationParams): string {
  if (!params) {
    return template;
  }

  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (key in params) {
      return String(params[key]);
    }
    return match;
  });
}

/**
 * Get a translation by key
 *
 * @param key - Dot-notation key (e.g., "nav.chat")
 * @param params - Optional interpolation parameters
 * @param fallback - Optional fallback string if key not found
 * @returns Translated string, fallback if provided, or key if not found
 */
export function t(key: string, params?: TranslationParams, fallback?: string): string {
  // Auto-initialize if not done
  if (!initialized) {
    // Synchronous fallback - load translations inline
    translations.set("en", flattenDict(enTranslations));
    translations.set("pt", flattenDict(ptTranslations));
    currentLocale = detectBrowserLocale();
    initialized = true;
  }

  // Try current locale first
  const currentDict = translations.get(currentLocale);
  if (currentDict && key in currentDict) {
    return interpolate(currentDict[key], params);
  }

  // Fall back to English
  if (currentLocale !== DEFAULT_LOCALE) {
    const defaultDict = translations.get(DEFAULT_LOCALE);
    if (defaultDict && key in defaultDict) {
      return interpolate(defaultDict[key], params);
    }
  }

  // Return fallback or key as last resort
  return fallback ? interpolate(fallback, params) : interpolate(key, params);
}

// Re-export types and constants
export { DEFAULT_LOCALE, SUPPORTED_LOCALES, LOCALE_NAMES } from "./types.js";
export type { Locale, TranslationParams } from "./types.js";
