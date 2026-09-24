import { describe, expect, it } from "vitest";
import {
	bindContextStrategy,
	CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
	ContextStrategyManagement,
	WRITE_HOOK_CONTEXT_ARTIFACTS,
	WRITE_HOOK_REAL_CONTEXT,
} from "../src/core/context-strategy/management.ts";
import { commitWorkingSetCut } from "../src/core/context-strategy/working-set-cut.ts";

const OWNER = "D:/ext/dynamite/src/index.ts";
const OTHER = "D:/ext/other/src/index.ts";

function occupiedManagement(extension = OWNER) {
	const management = new ContextStrategyManagement();
	management.configure({
		entryId: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
		implementationRef: "kappa-dynamite",
		reads: ["raw_history"],
		writes: [WRITE_HOOK_REAL_CONTEXT, WRITE_HOOK_CONTEXT_ARTIFACTS],
	});
	management.activate(CONTEXT_STRATEGY_DEFAULT_ENTRY_ID, { extension });
	return management;
}

function fakeSession() {
	const calls: unknown[] = [];
	const messages: unknown[] = ["before"];
	return {
		calls,
		messages,
		sessionManager: {
			appendCompaction: (...args: unknown[]) => {
				calls.push(args);
				return "cut-1";
			},
			buildSessionContext: () => ({ messages: [{ role: "user", content: "kept" }] }),
			getBranch: () => [{ id: "e1" }, { id: "keep-1" }],
		},
		setMessages: (next: unknown[]) => {
			messages.splice(0, messages.length, ...next);
		},
	};
}

describe("commitWorkingSetCut", () => {
	it("refuses when real_context.write has no owner", () => {
		const session = fakeSession();
		const result = commitWorkingSetCut({
			management: new ContextStrategyManagement(),
			sessionManager: session.sessionManager,
			setMessages: session.setMessages,
			isIdle: () => true,
			caller: { extension: OWNER },
			cut: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 10 },
		});
		expect(result).toEqual({ ok: false, code: "hook_not_owned" });
		expect(session.calls).toEqual([]);
		expect(session.messages).toEqual(["before"]);
	});

	it("refuses a non-owner caller without writing", () => {
		const session = fakeSession();
		const result = commitWorkingSetCut({
			management: occupiedManagement(),
			sessionManager: session.sessionManager,
			setMessages: session.setMessages,
			isIdle: () => true,
			caller: { extension: OTHER },
			cut: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 10 },
		});
		expect(result).toEqual({ ok: false, code: "not_hook_owner" });
		expect(session.calls).toEqual([]);
		expect(session.messages).toEqual(["before"]);
	});

	it("refuses to commit while the agent is not idle", () => {
		const session = fakeSession();
		const result = commitWorkingSetCut({
			management: occupiedManagement(),
			sessionManager: session.sessionManager,
			setMessages: session.setMessages,
			isIdle: () => false,
			caller: { extension: OWNER },
			cut: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 10 },
		});

		expect(result).toEqual({ ok: false, code: "not_idle" });
		expect(session.calls).toEqual([]);
		expect(session.messages).toEqual(["before"]);
	});

	it("refuses a firstKeptEntryId outside the current branch", () => {
		const session = fakeSession();
		const result = commitWorkingSetCut({
			management: occupiedManagement(),
			sessionManager: session.sessionManager,
			setMessages: session.setMessages,
			isIdle: () => true,
			caller: { extension: OWNER },
			cut: { summary: "s", firstKeptEntryId: "missing", tokensBefore: 10 },
		});

		expect(result).toEqual({ ok: false, code: "invalid_first_kept" });
		expect(session.calls).toEqual([]);
		expect(session.messages).toEqual(["before"]);
	});

	it("appends a compaction entry attributed to the occupying extension", () => {
		const session = fakeSession();
		const result = commitWorkingSetCut({
			management: occupiedManagement(),
			sessionManager: session.sessionManager,
			setMessages: session.setMessages,
			isIdle: () => true,
			caller: { extension: OWNER },
			cut: { summary: "history", firstKeptEntryId: "keep-1", tokensBefore: 99, details: { k: 1 } },
		});
		expect(result).toEqual({ ok: true, entryId: "cut-1" });
		expect(session.calls).toEqual([["history", "keep-1", 99, { k: 1 }, true, undefined, OWNER]]);
		expect(session.messages).toEqual([{ role: "user", content: "kept" }]);
	});

	it("lets a registered policy accept a collaborator cut and records that caller", () => {
		const management = occupiedManagement();
		expect(
			management.setCutPolicy(
				(cut, caller) => {
					return caller.extension === OTHER && cut.summary === "collab" ? { accept: true } : { accept: false };
				},
				{ extension: OWNER },
			),
		).toEqual({ ok: true });

		const session = fakeSession();
		const result = commitWorkingSetCut({
			management,
			sessionManager: session.sessionManager,
			setMessages: session.setMessages,
			isIdle: () => true,
			caller: { extension: OTHER },
			cut: { summary: "collab", firstKeptEntryId: "keep-1", tokensBefore: 1 },
		});
		expect(result).toEqual({ ok: true, entryId: "cut-1" });
		expect(session.calls[0]?.[6]).toBe(OTHER);
	});

	it("returns cut_rejected when the owner policy refuses a collaborator", () => {
		const management = occupiedManagement();
		management.setCutPolicy(() => ({ accept: false, reason: "no" }), { extension: OWNER });
		const session = fakeSession();
		const result = commitWorkingSetCut({
			management,
			sessionManager: session.sessionManager,
			setMessages: session.setMessages,
			isIdle: () => true,
			caller: { extension: OTHER },
			cut: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 1 },
		});
		expect(result).toEqual({ ok: false, code: "cut_rejected", reason: "no" });
		expect(session.calls).toEqual([]);
		expect(session.messages).toEqual(["before"]);
	});

	it("does not let a non-owner register cut policy", () => {
		const management = occupiedManagement();
		expect(management.setCutPolicy(() => ({ accept: true }), { extension: OTHER })).toEqual({
			ok: false,
			code: "not_hook_owner",
		});
	});

	it("clears collaborator policy when deactivate goes through the bound handle", () => {
		const management = occupiedManagement();
		const bound = bindContextStrategy(management, { extension: OWNER });
		expect(bound.setCutPolicy(() => ({ accept: true }))).toEqual({ ok: true });
		expect(bound.deactivate(CONTEXT_STRATEGY_DEFAULT_ENTRY_ID)).toEqual({
			ok: true,
			entryId: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
		});

		management.configure({
			entryId: "next-owner",
			implementationRef: "other",
			reads: ["raw_history"],
			writes: [WRITE_HOOK_REAL_CONTEXT],
		});
		expect(management.activate("next-owner", { extension: "D:/ext/next/src/index.ts" })).toEqual({
			ok: true,
			entryId: "next-owner",
		});

		const session = fakeSession();
		const result = commitWorkingSetCut({
			management,
			sessionManager: session.sessionManager,
			setMessages: session.setMessages,
			isIdle: () => true,
			caller: { extension: OTHER },
			cut: { summary: "stale-policy", firstKeptEntryId: "e1", tokensBefore: 1 },
		});
		expect(result).toEqual({ ok: false, code: "not_hook_owner" });
		expect(session.calls).toEqual([]);
	});
});
