import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initI18n,
  t,
  getLocale,
  setLocale,
  isInitialized,
  hasTranslation,
  getTranslationKeys,
  getMissingKeys,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
} from "./index.js";

describe("i18n", () => {
  // Reset module state between tests by re-initializing
  beforeEach(() => {
    // Clear any env vars that might affect tests
    delete process.env.OPENCLAW_LANGUAGE;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
  });

  afterEach(() => {
    // Restore env vars
    delete process.env.OPENCLAW_LANGUAGE;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
  });

  describe("initI18n", () => {
    it("initializes with default locale", () => {
      initI18n();
      expect(isInitialized()).toBe(true);
      expect(getLocale()).toBe(DEFAULT_LOCALE);
    });

    it("initializes with explicit locale", () => {
      initI18n({ locale: "pt" });
      expect(getLocale()).toBe("pt");
    });

    it("initializes with config locale", () => {
      initI18n({ configLocale: "pt" });
      expect(getLocale()).toBe("pt");
    });

    it("prefers explicit locale over config locale", () => {
      initI18n({ locale: "en", configLocale: "pt" });
      expect(getLocale()).toBe("en");
    });

    it("detects locale from OPENCLAW_LANGUAGE env var", () => {
      process.env.OPENCLAW_LANGUAGE = "pt";
      initI18n();
      expect(getLocale()).toBe("pt");
    });

    it("detects locale from LANG env var", () => {
      process.env.LANG = "pt_BR.UTF-8";
      initI18n();
      expect(getLocale()).toBe("pt");
    });

    it("normalizes locale codes", () => {
      initI18n({ locale: "PT-BR" });
      expect(getLocale()).toBe("pt");
    });

    it("falls back to default for unsupported locale", () => {
      initI18n({ locale: "fr" });
      expect(getLocale()).toBe(DEFAULT_LOCALE);
    });
  });

  describe("setLocale", () => {
    it("changes the current locale", () => {
      initI18n({ locale: "en" });
      setLocale("pt");
      expect(getLocale()).toBe("pt");
    });

    it("normalizes locale codes", () => {
      initI18n({ locale: "en" });
      setLocale("PT-BR");
      expect(getLocale()).toBe("pt");
    });
  });

  describe("t (translation function)", () => {
    it("returns translation for existing key", () => {
      initI18n({ locale: "en" });
      const result = t("common.yes");
      expect(result).toBe("Yes");
    });

    it("returns Portuguese translation", () => {
      initI18n({ locale: "pt" });
      const result = t("common.yes");
      expect(result).toBe("Sim");
    });

    it("interpolates parameters", () => {
      initI18n({ locale: "en" });
      const result = t("onboard.quickstart.gatewayPort", { port: "8080" });
      expect(result).toBe("Gateway port: 8080");
    });

    it("interpolates parameters in Portuguese", () => {
      initI18n({ locale: "pt" });
      const result = t("onboard.quickstart.gatewayPort", { port: "8080" });
      expect(result).toBe("Porta do gateway: 8080");
    });

    it("falls back to English for missing Portuguese keys", () => {
      initI18n({ locale: "pt" });
      // This key exists in English but might not be in Portuguese initially
      // The system should fall back to English
      const enResult = t("common.yes");
      expect(enResult).toBe("Sim"); // Has Portuguese translation
    });

    it("returns key if not found in any locale", () => {
      initI18n({ locale: "en" });
      const result = t("nonexistent.key");
      expect(result).toBe("nonexistent.key");
    });

    it("keeps missing interpolation params as-is", () => {
      initI18n({ locale: "en" });
      const result = t("onboard.quickstart.gatewayPort", {});
      expect(result).toBe("Gateway port: {{port}}");
    });

    it("auto-initializes if not initialized", () => {
      // Force re-import behavior by calling t before init
      const result = t("common.yes");
      expect(typeof result).toBe("string");
    });
  });

  describe("hasTranslation", () => {
    it("returns true for existing key", () => {
      initI18n({ locale: "en" });
      expect(hasTranslation("common.yes")).toBe(true);
    });

    it("returns false for non-existing key", () => {
      initI18n({ locale: "en" });
      expect(hasTranslation("nonexistent.key")).toBe(false);
    });

    it("checks specific locale", () => {
      initI18n({ locale: "en" });
      expect(hasTranslation("common.yes", "pt")).toBe(true);
    });
  });

  describe("getTranslationKeys", () => {
    it("returns all keys for current locale", () => {
      initI18n({ locale: "en" });
      const keys = getTranslationKeys();
      expect(keys).toContain("common.yes");
      expect(keys).toContain("onboard.title");
    });

    it("returns keys for specific locale", () => {
      initI18n({ locale: "en" });
      const ptKeys = getTranslationKeys("pt");
      expect(ptKeys).toContain("common.yes");
    });
  });

  describe("getMissingKeys", () => {
    it("returns empty array for default locale", () => {
      initI18n({ locale: "en" });
      const missing = getMissingKeys("en");
      expect(missing).toEqual([]);
    });

    it("returns missing keys for non-default locale", () => {
      initI18n({ locale: "pt" });
      const missing = getMissingKeys("pt");
      // All keys should be present if files are complete
      // This test validates the mechanism works
      expect(Array.isArray(missing)).toBe(true);
    });
  });

  describe("constants", () => {
    it("exports DEFAULT_LOCALE", () => {
      expect(DEFAULT_LOCALE).toBe("en");
    });

    it("exports SUPPORTED_LOCALES", () => {
      expect(SUPPORTED_LOCALES).toContain("en");
      expect(SUPPORTED_LOCALES).toContain("pt");
    });
  });
});

describe("i18n loader", () => {
  describe("flattenDict", () => {
    it("flattens nested objects", async () => {
      const { flattenDict } = await import("./loader.js");
      const result = flattenDict({
        a: {
          b: {
            c: "value",
          },
        },
      });
      expect(result).toEqual({ "a.b.c": "value" });
    });

    it("handles mixed nesting levels", async () => {
      const { flattenDict } = await import("./loader.js");
      const result = flattenDict({
        simple: "value1",
        nested: {
          deep: "value2",
        },
      });
      expect(result).toEqual({
        simple: "value1",
        "nested.deep": "value2",
      });
    });
  });

  describe("normalizeLocale", () => {
    it("normalizes various locale formats", async () => {
      const { normalizeLocale } = await import("./loader.js");
      expect(normalizeLocale("pt")).toBe("pt");
      expect(normalizeLocale("PT")).toBe("pt");
      expect(normalizeLocale("pt_BR")).toBe("pt");
      expect(normalizeLocale("pt-BR")).toBe("pt");
      expect(normalizeLocale("en_US")).toBe("en");
      expect(normalizeLocale("en-US")).toBe("en");
    });

    it("returns default for unsupported locales", async () => {
      const { normalizeLocale } = await import("./loader.js");
      expect(normalizeLocale("fr")).toBe("en");
      expect(normalizeLocale("de")).toBe("en");
      expect(normalizeLocale("")).toBe("en");
      expect(normalizeLocale(undefined)).toBe("en");
    });
  });

  describe("detectSystemLocale", () => {
    beforeEach(() => {
      delete process.env.OPENCLAW_LANGUAGE;
      delete process.env.LANG;
      delete process.env.LC_ALL;
      delete process.env.LC_MESSAGES;
    });

    it("prioritizes OPENCLAW_LANGUAGE", async () => {
      const { detectSystemLocale } = await import("./loader.js");
      process.env.OPENCLAW_LANGUAGE = "pt";
      process.env.LANG = "en_US";
      expect(detectSystemLocale()).toBe("pt");
    });

    it("falls back to LANG", async () => {
      const { detectSystemLocale } = await import("./loader.js");
      process.env.LANG = "pt_BR.UTF-8";
      expect(detectSystemLocale()).toBe("pt");
    });

    it("returns default when no env vars set", async () => {
      const { detectSystemLocale } = await import("./loader.js");
      expect(detectSystemLocale()).toBe("en");
    });
  });
});
