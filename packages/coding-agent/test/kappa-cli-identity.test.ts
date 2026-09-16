import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { setupCli } from "../src/cli/setup.ts";

const roots: string[] = [];
const packageUrl = new URL("../package.json", import.meta.url);
const configUrl = new URL("../src/config.ts", import.meta.url);
const publishedCli = join(dirname(fileURLToPath(import.meta.url)), "../dist/bundle/cli.js");

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function probeConfig(useOverride = false) {
	const root = mkdtempSync(join(tmpdir(), "kappa-identity-"));
	roots.push(root);
	const foreignPackage = join(root, "foreign-pi");
	mkdirSync(foreignPackage);
	writeFileSync(join(foreignPackage, "package.json"), JSON.stringify({
		name: "@earendil-works/pi-coding-agent", piConfig: { name: "pi", configDir: ".pi" },
	}));
	const probe = join(root, "probe.mjs");
	writeFileSync(probe, `import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR, getAgentDir, getSessionsDir } from ${JSON.stringify(configUrl.href)};
console.log(JSON.stringify({name: APP_NAME, config: CONFIG_DIR_NAME, env: ENV_AGENT_DIR, sessionEnv: ENV_SESSION_DIR, agent: getAgentDir(), sessions: getSessionsDir()}));\n`);
	const result = spawnSync(process.execPath, [probe], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			HOME: root,
			USERPROFILE: root,
			PI_PACKAGE_DIR: foreignPackage,
			PI_CODING_AGENT_DIR: join(root, "foreign-agent"),
			PI_CODING_AGENT_SESSION_DIR: join(root, "foreign-sessions"),
			...(useOverride ? { KAPPA_AGENT_DIR: join(root, "kappa-override") } : {}),
		},
		timeout: 15_000,
	});
	expect(result.status, `${result.stderr}\n${result.error ?? ""}`).toBe(0);
	return { root, config: JSON.parse(result.stdout) };
}

describe("Kappa operator identity", () => {
	it("publishes the kappa executable without taking over the pi command", () => {
		const manifest = JSON.parse(readFileSync(packageUrl, "utf8"));
		expect(manifest.bin).toEqual({ kappa: "dist/bundle/cli.js" });
	});

	it("uses its own state even when Pi environment overrides are inherited", () => {
		const { root, config } = probeConfig();
		expect(config).toEqual({
			name: "kappa", config: ".kappa", env: "KAPPA_AGENT_DIR", sessionEnv: "KAPPA_AGENT_SESSION_DIR",
			agent: join(root, ".kappa", "agent"), sessions: join(root, ".kappa", "agent", "sessions"),
		});
	});

	it("honors only the Kappa agent directory override", () => {
		const { root, config } = probeConfig(true);
		expect(config.agent).toBe(join(root, "kappa-override"));
		expect(config.sessions).toBe(join(root, "kappa-override", "sessions"));
	});

	it("prints Kappa env names from the published CLI bundle", () => {
		expect(existsSync(publishedCli), "rebuild packages/coding-agent so dist/bundle/cli.js matches source").toBe(true);
		const result = spawnSync(process.execPath, [publishedCli, "--help"], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				HOME: tmpdir(),
				USERPROFILE: tmpdir(),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				NO_COLOR: "1",
			},
			timeout: 20_000,
		});
		expect(result.status, `${result.stderr}\n${result.error ?? ""}`).toBe(0);
		const help = `${result.stdout}\n${result.stderr}`;
		expect(help).toContain("KAPPA_AGENT_DIR");
		expect(help).toContain("KAPPA_AGENT_SESSION_DIR");
		expect(help).toContain("KAPPA_PACKAGE_DIR");
		expect(help).not.toContain("PI_PACKAGE_DIR");
		expect(help).not.toContain("PI_CODING_AGENT_DIR");
		expect(help).not.toContain("KAPPA_CODING_AGENT_DIR");
	});

	it("marks CLI child processes as kappa, not pi", () => {
		const previous = {
			AI_AGENT: process.env.AI_AGENT,
			KAPPA_CODING_AGENT: process.env.KAPPA_CODING_AGENT,
			PI_CODING_AGENT: process.env.PI_CODING_AGENT,
		};
		process.env.PI_CODING_AGENT = "true";
		process.env.AI_AGENT = "pi";
		try {
			setupCli();
			expect(process.env.AI_AGENT).toBe("kappa");
			expect(process.env.KAPPA_CODING_AGENT).toBe("true");
			expect(process.env.PI_CODING_AGENT).toBeUndefined();
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
