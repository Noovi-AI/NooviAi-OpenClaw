/**
 * i18n Check Script
 *
 * Verifies that all translation keys exist in all supported locales.
 * Reports missing keys and helps maintain translation completeness.
 *
 * Usage:
 *   pnpm i18n:check           # Check for missing keys
 *   pnpm i18n:check --verbose # Show all keys
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const localesDir = path.join(repoRoot, "src", "i18n", "locales");

// Supported locales (en is the baseline)
const BASELINE_LOCALE = "en";
const SUPPORTED_LOCALES = ["en", "pt"];

interface TranslationDict {
	[key: string]: string | TranslationDict;
}

type FlatDict = Record<string, string>;

/**
 * Flatten nested object to dot-notation keys
 */
function flattenDict(dict: TranslationDict, prefix = ""): FlatDict {
	const result: FlatDict = {};

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
 * Load and flatten a locale file
 */
async function loadLocale(locale: string): Promise<FlatDict> {
	const filePath = path.join(localesDir, `${locale}.json`);

	try {
		const content = await fs.readFile(filePath, "utf-8");
		const dict = JSON.parse(content) as TranslationDict;
		return flattenDict(dict);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			console.error(`Locale file not found: ${filePath}`);
			return {};
		}
		throw err;
	}
}

/**
 * Compare locale against baseline and find missing keys
 */
function findMissingKeys(baseline: FlatDict, target: FlatDict): string[] {
	const baselineKeys = Object.keys(baseline);
	const targetKeys = new Set(Object.keys(target));

	return baselineKeys.filter((key) => !targetKeys.has(key));
}

/**
 * Find extra keys in target that don't exist in baseline
 */
function findExtraKeys(baseline: FlatDict, target: FlatDict): string[] {
	const baselineKeys = new Set(Object.keys(baseline));
	const targetKeys = Object.keys(target);

	return targetKeys.filter((key) => !baselineKeys.has(key));
}

async function main() {
	const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

	console.log("i18n Translation Check");
	console.log("======================\n");

	// Load baseline (English)
	const baseline = await loadLocale(BASELINE_LOCALE);
	const baselineKeyCount = Object.keys(baseline).length;

	console.log(`Baseline locale: ${BASELINE_LOCALE}`);
	console.log(`Total keys: ${baselineKeyCount}\n`);

	let hasErrors = false;

	// Check each non-baseline locale
	for (const locale of SUPPORTED_LOCALES) {
		if (locale === BASELINE_LOCALE) continue;

		console.log(`Checking locale: ${locale}`);
		console.log("-".repeat(30));

		const target = await loadLocale(locale);
		const targetKeyCount = Object.keys(target).length;

		const missingKeys = findMissingKeys(baseline, target);
		const extraKeys = findExtraKeys(baseline, target);

		const completeness = ((targetKeyCount - extraKeys.length) / baselineKeyCount) * 100;

		console.log(`  Keys: ${targetKeyCount}`);
		console.log(`  Completeness: ${completeness.toFixed(1)}%`);

		if (missingKeys.length > 0) {
			hasErrors = true;
			console.log(`  Missing: ${missingKeys.length} keys`);
			if (verbose) {
				for (const key of missingKeys.slice(0, 20)) {
					console.log(`    - ${key}`);
				}
				if (missingKeys.length > 20) {
					console.log(`    ... and ${missingKeys.length - 20} more`);
				}
			}
		} else {
			console.log("  Missing: 0 keys");
		}

		if (extraKeys.length > 0) {
			console.log(`  Extra: ${extraKeys.length} keys (not in baseline)`);
			if (verbose) {
				for (const key of extraKeys.slice(0, 10)) {
					console.log(`    + ${key}`);
				}
				if (extraKeys.length > 10) {
					console.log(`    ... and ${extraKeys.length - 10} more`);
				}
			}
		}

		console.log();
	}

	// Summary
	console.log("Summary");
	console.log("=======");

	if (hasErrors) {
		console.log("Some locales have missing keys. Run with --verbose for details.");
		process.exit(1);
	} else {
		console.log("All locales are complete!");
		process.exit(0);
	}
}

// Run if executed directly
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((err) => {
		console.error("Error:", err);
		process.exit(1);
	});
}

export { loadLocale, findMissingKeys, findExtraKeys, flattenDict };
