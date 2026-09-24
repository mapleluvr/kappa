import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPiManifest } from "../src/core/pi-manifest.ts";

function writePkg(body: unknown): string {
	const dir = join(tmpdir(), `kappa-manifest-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "package.json");
	writeFileSync(path, JSON.stringify(body), "utf8");
	return path;
}

describe("readPiManifest", () => {
	it("prefers kappa.extensions over pi.extensions", () => {
		const path = writePkg({
			kappa: { extensions: ["./src/index.ts"] },
			pi: { extensions: ["./legacy.ts"] },
		});
		expect(readPiManifest(path)).toEqual({ extensions: ["./src/index.ts"] });
	});

	it("reads kappa-only manifests", () => {
		const path = writePkg({ kappa: { extensions: ["./src/index.ts"] } });
		expect(readPiManifest(path)).toEqual({ extensions: ["./src/index.ts"] });
	});

	it("chooses each resource field independently and keeps explicit empty kappa arrays", () => {
		const path = writePkg({
			kappa: { extensions: [], skills: ["./kappa-skill.md"], prompts: [false] },
			pi: {
				extensions: ["./legacy-extension.ts"],
				skills: ["./legacy-skill.md"],
				prompts: ["./legacy-prompt.md"],
				themes: ["./legacy-theme.json"],
			},
		});
		expect(readPiManifest(path)).toEqual({
			extensions: [],
			skills: ["./kappa-skill.md"],
			prompts: ["./legacy-prompt.md"],
			themes: ["./legacy-theme.json"],
		});
	});
});
