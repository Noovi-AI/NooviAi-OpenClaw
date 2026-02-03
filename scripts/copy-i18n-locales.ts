/**
 * Copy i18n locale JSON files to dist during build
 *
 * This script copies the translation files from src/i18n/locales to dist/i18n/locales
 * so they can be loaded at runtime.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function getI18nPaths(env = process.env) {
	const srcDir = env.OPENCLAW_I18N_SRC_DIR ?? path.join(repoRoot, "src", "i18n", "locales");
	const outDir = env.OPENCLAW_I18N_OUT_DIR ?? path.join(repoRoot, "dist", "i18n", "locales");
	return { srcDir, outDir };
}

export async function copyI18nLocales({ srcDir, outDir }: { srcDir: string; outDir: string }) {
	try {
		await fs.stat(srcDir);
	} catch (err) {
		console.warn(`i18n locales directory not found: ${srcDir}`);
		return;
	}

	await fs.mkdir(outDir, { recursive: true });

	const files = await fs.readdir(srcDir);
	for (const file of files) {
		if (file.endsWith(".json")) {
			const srcPath = path.join(srcDir, file);
			const outPath = path.join(outDir, file);
			await fs.copyFile(srcPath, outPath);
			console.log(`Copied: ${file}`);
		}
	}
}

async function main() {
	const { srcDir, outDir } = getI18nPaths();
	console.log(`Copying i18n locales from ${srcDir} to ${outDir}`);
	await copyI18nLocales({ srcDir, outDir });
	console.log("Done copying i18n locales.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((err) => {
		console.error(String(err));
		process.exit(1);
	});
}
