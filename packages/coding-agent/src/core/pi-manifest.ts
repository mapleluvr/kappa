import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

export interface PiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg)) {
			return null;
		}
		const kappa = isObject(pkg.kappa) ? pkg.kappa : undefined;
		const pi = isObject(pkg.pi) ? pkg.pi : undefined;
		if (!kappa && !pi) {
			return null;
		}

		const manifest: PiManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const preferred = readStringArray(kappa?.[field]) ?? readStringArray(pi?.[field]);
			if (preferred) {
				manifest[field] = preferred;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}

function readStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
		return value;
	}
	return undefined;
}
