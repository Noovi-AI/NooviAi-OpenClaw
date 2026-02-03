/**
 * Translation file loader for OpenClaw i18n
 *
 * Loads translation JSON files and provides locale detection.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FlatTranslationDict, Locale, TranslationDict } from "./types.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Flatten a nested translation dictionary into dot-notation keys
 */
export function flattenDict(dict: TranslationDict, prefix = ""): FlatTranslationDict {
  const result: FlatTranslationDict = {};

  for (const [key, value] of Object.entries(dict)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "string") {
      result[fullKey] = value;
    } else if (typeof value === "object" && value !== null) {
      Object.assign(result, flattenDict(value, fullKey));
    }
  }

  return result;
}

/**
 * Load translations from a JSON file
 */
export function loadTranslationFile(locale: Locale): FlatTranslationDict {
  const filePath = join(__dirname, "locales", `${locale}.json`);

  if (!existsSync(filePath)) {
    console.warn(`Translation file not found: ${filePath}`);
    return {};
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const dict = JSON.parse(content) as TranslationDict;
    return flattenDict(dict);
  } catch (err) {
    console.warn(`Failed to load translation file ${filePath}:`, err);
    return {};
  }
}

/**
 * Load all translations for all supported locales
 */
export function loadAllTranslations(): Map<Locale, FlatTranslationDict> {
  const translations = new Map<Locale, FlatTranslationDict>();

  for (const locale of SUPPORTED_LOCALES) {
    translations.set(locale, loadTranslationFile(locale));
  }

  return translations;
}

/**
 * Detect system locale from environment variables
 *
 * Checks: OPENCLAW_LANGUAGE, LANG, LC_ALL, LC_MESSAGES
 * Returns DEFAULT_LOCALE if no valid locale detected
 */
export function detectSystemLocale(): Locale {
  // Priority: explicit OpenClaw setting > LANG > LC_ALL > LC_MESSAGES
  const candidates = [
    process.env.OPENCLAW_LANGUAGE,
    process.env.LANG,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    // Handle formats like "pt_BR.UTF-8", "en_US", "pt", "en"
    const normalized = candidate.toLowerCase().split(".")[0]; // Remove encoding

    // Check for exact match (e.g., "pt" or "en")
    if (SUPPORTED_LOCALES.includes(normalized as Locale)) {
      return normalized as Locale;
    }

    // Check for language prefix (e.g., "pt_BR" -> "pt")
    const langPrefix = normalized.split("_")[0];
    if (SUPPORTED_LOCALES.includes(langPrefix as Locale)) {
      return langPrefix as Locale;
    }
  }

  return DEFAULT_LOCALE;
}

/**
 * Validate and normalize a locale string
 */
export function normalizeLocale(locale: string | undefined): Locale {
  if (!locale) return DEFAULT_LOCALE;

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
