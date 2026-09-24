import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

describe("working-set cut persistence", () => {
	it("round-trips hook attribution and rebuilds the selected session tail", () => {
		const directory = mkdtempSync(join(tmpdir(), "working-set-cut-"));
		try {
			const session = SessionManager.create(directory, directory);
			const discardedId = session.appendMessage({ role: "user", content: "discarded history", timestamp: Date.now() });
			const keptId = session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "kept reply" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			const cutId = session.appendCompaction("working summary", keptId, 200, { source: "test" }, true, undefined, "D:/extensions/reducer.ts");
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");

			const reopened = SessionManager.open(sessionFile, directory);
			const cut = reopened.getEntries().find((entry) => entry.id === cutId);
			expect(cut).toMatchObject({
				type: "compaction",
				fromHook: true,
				authorExtension: "D:/extensions/reducer.ts",
			});
			expect(reopened.buildContextEntries().map((entry) => entry.id)).toEqual([cutId, keptId]);
			expect(reopened.buildContextEntries().some((entry) => entry.id === discardedId)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
