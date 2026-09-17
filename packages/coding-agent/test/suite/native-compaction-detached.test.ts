import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_COMPACTION_DISABLED_MESSAGE } from "../../src/core/context-strategy/native-compaction.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { createHarness, type Harness } from "./harness.ts";

type SessionCompactionInternals = {
	_checkCompaction: (
		assistantMessage: ReturnType<typeof fauxAssistantMessage>,
		skipAbortedCheck?: boolean,
	) => Promise<boolean>;
};

describe("native Pi compaction operations are detached", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("refuses AgentSession.compact without writing a compaction entry", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await expect(harness.session.compact()).rejects.toThrow(NATIVE_COMPACTION_DISABLED_MESSAGE);
		expect(harness.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("does not run threshold or overflow auto-compaction", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setAutoCompactionEnabled(true);
		expect(harness.session.autoCompactionEnabled).toBe(false);

		const model = harness.getModel();
		const assistant = {
			...fauxAssistantMessage("", { stopReason: "length" }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 200_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 200_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const internals = harness.session as unknown as SessionCompactionInternals;
		expect(await internals._checkCompaction(assistant, false)).toBe(false);
		expect(harness.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("does not list /compact as a builtin slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).not.toContain("compact");
	});
});
