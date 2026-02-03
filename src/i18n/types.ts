/**
 * i18n type definitions for OpenClaw
 *
 * This module provides TypeScript types for translation keys and locales.
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
  pt: "Português (Brasil)",
};

/**
 * Translation parameters for interpolation
 * Example: t("hello.name", { name: "John" }) => "Hello, John!"
 */
export type TranslationParams = Record<string, string | number | boolean>;

/**
 * Translation function signature
 */
export type TranslationFunction = (key: string, params?: TranslationParams) => string;

/**
 * Translation dictionary structure (nested keys)
 * Example: { onboard: { security: { title: "Security warning" } } }
 */
export type TranslationDict = {
  [key: string]: string | TranslationDict;
};

/**
 * Flattened translation dictionary (dot-notation keys)
 * Example: { "onboard.security.title": "Security warning" }
 */
export type FlatTranslationDict = Record<string, string>;
