/**
 * i18n type definitions for OpenClaw Web UI
 */

/** Supported locales */
export type Locale = "en" | "pt";

/** Default locale (English) */
export const DEFAULT_LOCALE: Locale = "en";

/** Supported locales list */
export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "pt"] as const;

/** Locale display names */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  pt: "Portugues (Brasil)",
};

/**
 * Translation parameters for interpolation
 */
export type TranslationParams = Record<string, string | number | boolean>;

/**
 * Translation dictionary structure (nested keys)
 */
export type TranslationDict = {
  [key: string]: string | TranslationDict;
};

/**
 * Flattened translation dictionary (dot-notation keys)
 */
export type FlatTranslationDict = Record<string, string>;
