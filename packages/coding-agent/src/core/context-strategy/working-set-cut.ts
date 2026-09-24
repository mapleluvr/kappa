import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { ContextStrategyManagement, CutCaller } from "./management.ts";

export type WorkingSetCut = {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: unknown;
	usage?: Usage;
};

export type CommitWorkingSetCutResult =
	| { ok: true; entryId: string }
	| { ok: false; code: "hook_not_owned" | "not_hook_owner" | "not_idle" | "invalid_first_kept" }
	| { ok: false; code: "cut_rejected"; reason?: string };

export function commitWorkingSetCut(args: {
	management: ContextStrategyManagement;
	sessionManager: {
		appendCompaction: (
			summary: string,
			firstKeptEntryId: string,
			tokensBefore: number,
			details?: unknown,
			fromHook?: boolean,
			usage?: Usage,
			authorExtension?: string,
		) => string;
		buildSessionContext: () => { messages: AgentMessage[] };
		getBranch: () => Array<{ id: string }>;
	};
	setMessages: (messages: AgentMessage[]) => void;
	isIdle: () => boolean;
	caller: CutCaller;
	cut: WorkingSetCut;
}): CommitWorkingSetCutResult {
	const gate = args.management.authorizeCut(args.caller, args.cut);
	if (!gate.ok) {
		return gate;
	}
	if (!args.isIdle()) {
		return { ok: false, code: "not_idle" };
	}
	if (!args.sessionManager.getBranch().some((entry) => entry.id === args.cut.firstKeptEntryId)) {
		return { ok: false, code: "invalid_first_kept" };
	}
	const entryId = args.sessionManager.appendCompaction(
		args.cut.summary,
		args.cut.firstKeptEntryId,
		args.cut.tokensBefore,
		args.cut.details,
		true,
		args.cut.usage,
		args.caller.extension,
	);
	args.setMessages(args.sessionManager.buildSessionContext().messages);
	return { ok: true, entryId };
}
