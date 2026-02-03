/**
 * OpenClaw Internationalization (i18n) Module
 *
 * Provides translation support for the CLI interface.
 *
 * Usage:
 *   import { t, initI18n, getLocale, setLocale } from "./i18n/index.js";
 *
 *   // Initialize at startup (auto-detects locale)
 *   initI18n();
 *
 *   // Or initialize with explicit locale
 *   initI18n({ locale: "pt" });
 *
 *   // Use translations
 *   console.log(t("onboard.security.title"));
 *   // => "Security warning — please read."
 *
 *   // With interpolation
 *   console.log(t("config.saved", { path: "/home/user/.openclaw/config.json5" }));
 *   // => "Configuration saved to /home/user/.openclaw/config.json5"
 */

import type { FlatTranslationDict, Locale, TranslationParams } from "./types.js";
import { detectSystemLocale, loadAllTranslations, normalizeLocale } from "./loader.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./types.js";

// Module state
let currentLocale: Locale = DEFAULT_LOCALE;
let translations: Map<Locale, FlatTranslationDict> = new Map();
let initialized = false;

/**
 * Initialize the i18n system
 *
 * @param options.locale - Explicit locale to use (overrides auto-detection)
 * @param options.configLocale - Locale from config file (lower priority than explicit)
 */
export function initI18n(options?: { locale?: string; configLocale?: string }): void {
  // Load all translation files
  translations = loadAllTranslations();

  // Determine locale (priority: explicit > config > env > default)
  if (options?.locale) {
    currentLocale = normalizeLocale(options.locale);
  } else if (options?.configLocale) {
    currentLocale = normalizeLocale(options.configLocale);
  } else {
    currentLocale = detectSystemLocale();
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
 * Set the current locale
 */
export function setLocale(locale: string): void {
  currentLocale = normalizeLocale(locale);
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
 * Example: "Hello, {{name}}!" with { name: "World" } => "Hello, World!"
 */
function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;

  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (key in params) {
      return String(params[key]);
    }
    return match; // Keep original if param not found
  });
}

/**
 * Get a translation by key
 *
 * @param key - Dot-notation key (e.g., "onboard.security.title")
 * @param params - Optional interpolation parameters
 * @returns Translated string, or key if not found
 *
 * Falls back to English if translation not found in current locale.
 * Returns the key itself if not found in any locale.
 */
export function t(key: string, params?: TranslationParams): string {
  // Auto-initialize if not done (for convenience during migration)
  if (!initialized) {
    initI18n();
  }

  // Try current locale first
  const currentDict = translations.get(currentLocale);
  if (currentDict && key in currentDict) {
    return interpolate(currentDict[key], params);
  }

  // Fall back to English (default)
  if (currentLocale !== DEFAULT_LOCALE) {
    const defaultDict = translations.get(DEFAULT_LOCALE);
    if (defaultDict && key in defaultDict) {
      return interpolate(defaultDict[key], params);
    }
  }

  // Return key as fallback (useful during development)
  return interpolate(key, params);
}

/**
 * Check if a translation key exists
 */
export function hasTranslation(key: string, locale?: Locale): boolean {
  const targetLocale = locale ?? currentLocale;
  const dict = translations.get(targetLocale);
  return dict ? key in dict : false;
}

/**
 * Get all translation keys for a locale
 */
export function getTranslationKeys(locale?: Locale): string[] {
  const targetLocale = locale ?? currentLocale;
  const dict = translations.get(targetLocale);
  return dict ? Object.keys(dict) : [];
}

/**
 * Get missing keys (keys in default locale but not in target locale)
 */
export function getMissingKeys(locale?: Locale): string[] {
  const targetLocale = locale ?? currentLocale;
  if (targetLocale === DEFAULT_LOCALE) return [];

  const defaultKeys = getTranslationKeys(DEFAULT_LOCALE);
  const targetKeys = new Set(getTranslationKeys(targetLocale));

  return defaultKeys.filter((key) => !targetKeys.has(key));
}

// Re-export types and constants
export { DEFAULT_LOCALE, SUPPORTED_LOCALES, LOCALE_NAMES } from "./types.js";
export type { Locale, TranslationParams, TranslationFunction } from "./types.js";
