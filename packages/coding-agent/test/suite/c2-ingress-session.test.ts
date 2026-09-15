import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	C2_EMPTY_LEAF_ID,
	type C2Accepted,
	type C2Ingress,
	C2RefusedError,
	type C2Result,
} from "../../src/core/c2-ingress.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function requireAccepted(result: C2Result | undefined): C2Accepted {
	if (result?.status !== "accepted") {
		throw new Error(`expected accepted C2 result, got ${result?.status ?? "undefined"}`);
	}
	return result;
}

function sessionC2Ingress(session: AgentSession): C2Ingress {
	return (session as unknown as { _c2Ingress: C2Ingress })._c2Ingress;
}

describe("C2 AgentSession production ingress", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("accepted prompt writes through the existing AgentSession path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi", {
			requestId: "request-fixture-0001",
			idempotencyKey: "idem-prompt-1",
			actor: "operator-fixture-0001",
		});

		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[0]!)).toBe("hi");
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			kind: "user_input",
			replayed: false,
			record: {
				requestId: "request-fixture-0001",
				sessionId: harness.session.sessionId,
				branchId: C2_EMPTY_LEAF_ID,
				cause: "prompt",
				source: { kind: "external_user", actorRef: "operator-fixture-0001" },
				payload: { text: "hi" },
				provenance: { path: "P1.ingress", strategyRef: null },
			},
		});
		expect(harness.eventsOfType("agent_end").length).toBeGreaterThan(0);
		expect(harness.eventsOfType("agent_settled").length).toBeGreaterThan(0);
		expect(harness.events.some((event) => event.type === "agent_end")).toBe(true);
		expect(harness.events.some((event) => event.type === "agent_settled")).toBe(true);
	});

	it("maps steer and followUp to user_input rather than unknown_kind", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.steer("steer now", undefined, {
			requestId: "request-steer-1",
			idempotencyKey: "idem-steer-1",
		});
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			kind: "user_input",
			record: {
				cause: "steer",
				source: { kind: "external_user" },
				payload: { text: "steer now" },
				provenance: { path: "P1.ingress", strategyRef: null },
			},
		});

		await harness.session.followUp("later", undefined, {
			requestId: "request-follow-1",
			idempotencyKey: "idem-follow-1",
		});
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			kind: "user_input",
			record: {
				cause: "followUp",
				source: { kind: "external_user" },
				payload: { text: "later" },
				provenance: { path: "P1.ingress", strategyRef: null },
			},
		});
	});

	it("accepted tool result carries native provenance through afterToolCall persistence", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role).toBe("toolResult");
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			kind: "tool_result",
			record: {
				source: {
					kind: "native_tool_execution",
					toolCallRef: toolResult && "toolCallId" in toolResult ? toolResult.toolCallId : "",
				},
				provenance: { path: "P2.content", storagePath: "P7.storage.append", strategyRef: null },
			},
		});
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toBe(true);
	});

	it("refuses stale navigateTree without mutating the session tree", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const leafBefore = harness.sessionManager.getLeafId();
		const entriesBefore = harness.sessionManager.getEntries().map((entry) => entry.id);
		const messagesBefore = harness.session.messages.map((message) => getMessageText(message));
		const target = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(target).toBeDefined();
		expect(leafBefore).toBeTruthy();

		await expect(
			harness.session.navigateTree(target!.id, {
				summarize: false,
				requestId: "request-fixture-0003",
				idempotencyKey: "idem-nav-stale",
				baseRevision: 0,
			}),
		).rejects.toBeInstanceOf(C2RefusedError);

		expect(harness.session.lastC2Result).toMatchObject({
			status: "refused",
			code: "revision_conflict",
			operation: "branch_control",
			requestId: "request-fixture-0003",
			sessionId: harness.session.sessionId,
			branchId: leafBefore,
			sideEffect: "none",
			retry: "re-read-and-resubmit",
			reconcile: false,
		});
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.sessionManager.getEntries().map((entry) => entry.id)).toEqual(entriesBefore);
		expect(harness.session.messages.map((message) => getMessageText(message))).toEqual(messagesBefore);
	});

	it("refuses the same key with a different payload without writing again", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.steer("one", undefined, {
			requestId: "request-a",
			idempotencyKey: "shared-key",
		});
		const entriesBefore = harness.sessionManager.getEntries().map((entry) => entry.id);
		const queuedBefore = [...harness.session.getSteeringMessages()];

		await expect(
			harness.session.steer("two", undefined, {
				requestId: "request-b",
				idempotencyKey: "shared-key",
			}),
		).rejects.toBeInstanceOf(C2RefusedError);

		expect(harness.session.lastC2Result).toMatchObject({
			status: "refused",
			code: "idempotency_conflict",
			operation: "user_input",
			requestId: "request-b",
			sideEffect: "none",
			retry: "inspect-before-retry",
			reconcile: false,
		});
		expect(harness.sessionManager.getEntries().map((entry) => entry.id)).toEqual(entriesBefore);
		expect(harness.session.getSteeringMessages()).toEqual(queuedBefore);
	});

	it("refused input leaves the session unchanged", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should not run")]);

		await expect(
			harness.session.prompt("nope", {
				requestId: "   ",
				idempotencyKey: "idem-blank",
			}),
		).rejects.toBeInstanceOf(C2RefusedError);

		expect(harness.session.lastC2Result).toMatchObject({
			status: "refused",
			code: "missing_field",
			field: "requestId",
			sideEffect: "none",
			reconcile: false,
		});
		expect(harness.session.messages).toEqual([]);
		expect(harness.sessionManager.getEntries()).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("retries prompt with the same key after a failure before Pi write", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		let promptCalls = 0;
		const originalPrompt = harness.session.agent.prompt.bind(harness.session.agent);
		const promptWithFailure: typeof harness.session.agent.prompt = async (input, images?) => {
			promptCalls += 1;
			if (promptCalls === 1) {
				throw new Error("injected agent.prompt failure");
			}
			return originalPrompt(input as never, images as never);
		};
		harness.session.agent.prompt = promptWithFailure;

		await expect(
			harness.session.prompt("hi", {
				requestId: "request-fail",
				idempotencyKey: "idem-prompt-retry",
			}),
		).rejects.toThrow("injected agent.prompt failure");
		expect(harness.sessionManager.getEntries()).toEqual([]);

		await harness.session.prompt("hi", {
			requestId: "request-retry",
			idempotencyKey: "idem-prompt-retry",
		});
		expect(promptCalls).toBe(2);
		expect(getMessageText(harness.session.messages[0]!)).toBe("hi");
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			replayed: false,
			record: { cause: "prompt", payload: { text: "hi" } },
		});
	});

	it("retries steer and followUp with the same key after queue failure", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let steerCalls = 0;
		let followUpCalls = 0;
		const originalSteer = harness.session.agent.steer.bind(harness.session.agent);
		const originalFollowUp = harness.session.agent.followUp.bind(harness.session.agent);
		harness.session.agent.steer = (message) => {
			steerCalls += 1;
			if (steerCalls === 1) {
				throw new Error("injected steer failure");
			}
			originalSteer(message);
		};
		harness.session.agent.followUp = (message) => {
			followUpCalls += 1;
			if (followUpCalls === 1) {
				throw new Error("injected followUp failure");
			}
			originalFollowUp(message);
		};

		await expect(
			harness.session.steer("steer now", undefined, {
				requestId: "request-steer-fail",
				idempotencyKey: "idem-steer-retry",
			}),
		).rejects.toThrow("injected steer failure");
		await harness.session.steer("steer now", undefined, {
			requestId: "request-steer-retry",
			idempotencyKey: "idem-steer-retry",
		});
		expect(steerCalls).toBe(2);

		await expect(
			harness.session.followUp("later", undefined, {
				requestId: "request-follow-fail",
				idempotencyKey: "idem-follow-retry",
			}),
		).rejects.toThrow("injected followUp failure");
		await harness.session.followUp("later", undefined, {
			requestId: "request-follow-retry",
			idempotencyKey: "idem-follow-retry",
		});
		expect(followUpCalls).toBe(2);
	});

	it("retries navigateTree with the same key after cancel", async () => {
		let cancelNext = true;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => (cancelNext ? { cancel: true } : undefined));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const leafBefore = harness.sessionManager.getLeafId();
		const target = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(target).toBeDefined();

		const cancelled = await harness.session.navigateTree(target!.id, {
			summarize: false,
			requestId: "request-nav-cancel",
			idempotencyKey: "idem-nav-retry",
		});
		expect(cancelled).toEqual({ cancelled: true });
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);

		cancelNext = false;
		const retried = await harness.session.navigateTree(target!.id, {
			summarize: false,
			requestId: "request-nav-retry",
			idempotencyKey: "idem-nav-retry",
		});
		expect(retried.cancelled).toBe(false);
		expect(harness.sessionManager.getLeafId()).not.toBe(leafBefore);
	});

	it("uses the session tree leaf or empty sentinel and conflicts after no-summary navigation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("second reply"),
			fauxAssistantMessage("should not run"),
		]);

		await harness.session.prompt("first", {
			requestId: "request-leaf-1",
			idempotencyKey: "idem-leaf-1",
		});
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			record: { branchId: C2_EMPTY_LEAF_ID },
		});

		await harness.session.prompt("second", {
			requestId: "request-leaf-2",
			idempotencyKey: "idem-leaf-2",
		});
		const leafBeforeNav = harness.sessionManager.getLeafId();
		expect(leafBeforeNav).toBeTruthy();
		const target = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(target).toBeDefined();

		const navigated = await harness.session.navigateTree(target!.id, {
			summarize: false,
			requestId: "request-nav-ok",
			idempotencyKey: "idem-nav-ok",
		});
		expect(navigated.cancelled).toBe(false);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			record: { branchId: leafBeforeNav },
		});
		if (harness.session.lastC2Result?.status !== "accepted") {
			throw new Error("expected navigation admission");
		}
		const oldRevision = harness.session.lastC2Result.record.baseRevision;

		await expect(
			harness.session.prompt("third", {
				requestId: "request-stale-after-nav",
				idempotencyKey: "idem-stale-after-nav",
				baseRevision: oldRevision,
			}),
		).rejects.toBeInstanceOf(C2RefusedError);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "refused",
			code: "revision_conflict",
			sideEffect: "none",
		});
	});

	it("replays a successful prompt with the same key after the leaf moves", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello"), fauxAssistantMessage("should not run")]);

		await harness.session.prompt("hi", {
			requestId: "request-prompt-success",
			idempotencyKey: "idem-prompt-success",
		});
		const original = requireAccepted(harness.session.lastC2Result).record;
		expect(original.branchId).toBe(C2_EMPTY_LEAF_ID);
		const messagesAfter = harness.session.messages.map((message) => getMessageText(message));
		const entriesAfter = harness.sessionManager.getEntries().map((entry) => entry.id);
		const leafAfter = harness.sessionManager.getLeafId();
		expect(leafAfter).toBeTruthy();
		expect(leafAfter).not.toBe(C2_EMPTY_LEAF_ID);

		await harness.session.prompt("hi", {
			requestId: "request-prompt-success-retry",
			idempotencyKey: "idem-prompt-success",
			branchId: original.branchId,
			baseRevision: original.baseRevision,
		});
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			replayed: true,
			record: original,
		});
		expect(harness.session.messages.map((message) => getMessageText(message))).toEqual(messagesAfter);
		expect(harness.sessionManager.getEntries().map((entry) => entry.id)).toEqual(entriesAfter);
		expect(harness.sessionManager.getLeafId()).toBe(leafAfter);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("replays a committed tool result with the original identity after the leaf moves", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }, { id: "tool-success-replay" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start", {
			requestId: "request-tool-success",
			idempotencyKey: "idem-tool-prompt",
		});
		const toolAccepted = harness
			.eventsOfType("c2_result")
			.map((event) => event.result)
			.filter((result): result is C2Accepted => result.status === "accepted" && result.kind === "tool_result");
		expect(toolAccepted).toHaveLength(1);
		const original = toolAccepted[0]!.record;
		expect(harness.sessionManager.getLeafId()).not.toBe(original.branchId);

		const retry = sessionC2Ingress(harness.session).submit({
			...original,
			requestId: "request-tool-success-retry",
		});
		expect(retry).toMatchObject({
			status: "accepted",
			kind: "tool_result",
			replayed: true,
			record: original,
		});
	});

	it("replays a successful navigateTree with the same key after the leaf moves", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const leafBefore = harness.sessionManager.getLeafId();
		const target = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(target).toBeDefined();

		const firstNav = await harness.session.navigateTree(target!.id, {
			summarize: false,
			requestId: "request-nav-success",
			idempotencyKey: "idem-nav-success",
		});
		expect(firstNav.cancelled).toBe(false);
		const original = requireAccepted(harness.session.lastC2Result).record;
		const leafAfter = harness.sessionManager.getLeafId();
		expect(leafAfter).not.toBe(leafBefore);
		const entriesAfter = harness.sessionManager.getEntries().map((entry) => entry.id);

		const replayed = await harness.session.navigateTree(target!.id, {
			summarize: false,
			requestId: "request-nav-success-retry",
			idempotencyKey: "idem-nav-success",
			branchId: original.branchId,
			baseRevision: original.baseRevision,
		});
		expect(replayed.cancelled).toBe(false);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			replayed: true,
			record: original,
		});
		expect(harness.sessionManager.getLeafId()).toBe(leafAfter);
		expect(harness.sessionManager.getEntries().map((entry) => entry.id)).toEqual(entriesAfter);
	});

	it("does not share idempotency keys across branches", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("second reply"),
			fauxAssistantMessage("fork reply"),
		]);

		await harness.session.prompt("first", {
			requestId: "request-branch-1",
			idempotencyKey: "idem-first",
		});
		await harness.session.prompt("second", {
			requestId: "request-branch-2",
			idempotencyKey: "shared-branch-key",
		});
		const secondRecord = requireAccepted(harness.session.lastC2Result).record;
		const firstUser = harness.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" && entry.message.role === "user" && getMessageText(entry.message) === "first",
			);
		expect(firstUser).toBeDefined();

		await harness.session.navigateTree(firstUser!.id, {
			summarize: false,
			requestId: "request-branch-nav",
			idempotencyKey: "idem-branch-nav",
		});

		await harness.session.prompt("fork", {
			requestId: "request-branch-3",
			idempotencyKey: "shared-branch-key",
		});
		const forkRecord = requireAccepted(harness.session.lastC2Result).record;
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			replayed: false,
			record: { payload: { text: "fork" }, idempotencyKey: "shared-branch-key" },
		});
		expect(forkRecord.branchId).not.toBe(secondRecord.branchId);
		expect(getMessageText(harness.session.messages[0]!)).toBe("fork");
	});

	it("rejects a stale new request after a successful write", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("should not run")]);

		await harness.session.prompt("first", {
			requestId: "request-stale-src",
			idempotencyKey: "idem-stale-src",
		});
		const original = requireAccepted(harness.session.lastC2Result).record;
		const entriesAfter = harness.sessionManager.getEntries().map((entry) => entry.id);

		await expect(
			harness.session.prompt("second", {
				requestId: "request-stale-new",
				idempotencyKey: "idem-stale-new",
				baseRevision: original.baseRevision,
			}),
		).rejects.toBeInstanceOf(C2RefusedError);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "refused",
			code: "revision_conflict",
			requestId: "request-stale-new",
			sideEffect: "none",
			retry: "re-read-and-resubmit",
		});
		expect(harness.sessionManager.getEntries().map((entry) => entry.id)).toEqual(entriesAfter);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("completes C2 before emitInput, flush, and compaction so refusal has no side effects", async () => {
		let inputSeen = 0;
		let compactAttempted = false;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("input", () => {
						inputSeen += 1;
						return { action: "continue" };
					});
					pi.on("session_before_compact", () => {
						compactAttempted = true;
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.agent.state.model = { ...model, contextWindow: 32 };
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: now - 1000,
		});
		const assistant = {
			...fauxAssistantMessage("old reply"),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 500,
		};
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const entriesBefore = harness.sessionManager.getEntries().map((entry) => entry.id);

		await expect(
			harness.session.prompt("nope", {
				requestId: "   ",
				idempotencyKey: "idem-no-side-effect",
			}),
		).rejects.toBeInstanceOf(C2RefusedError);
		expect(inputSeen).toBe(0);
		expect(compactAttempted).toBe(false);
		expect(harness.sessionManager.getEntries().map((entry) => entry.id)).toEqual(entriesBefore);
	});

	it("admits handled prompt input through C2 and skips emitInput on replay", async () => {
		let inputSeen = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => {
						inputSeen += 1;
						return { action: "handled" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should not run")]);

		await harness.session.prompt("ping", {
			requestId: "request-handled",
			idempotencyKey: "idem-handled",
		});
		expect(inputSeen).toBe(1);
		expect(harness.session.messages).toEqual([]);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			kind: "user_input",
			replayed: false,
			record: {
				cause: "prompt",
				payload: { text: "ping" },
				branchId: C2_EMPTY_LEAF_ID,
			},
		});

		await harness.session.prompt("ping", {
			requestId: "request-handled-retry",
			idempotencyKey: "idem-handled",
		});
		expect(inputSeen).toBe(1);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			replayed: true,
		});
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("retries abort-cancelled steer and followUp with the same key", async () => {
		let releaseWait: (() => void) | undefined;
		const waitReleased = new Promise<void>((resolve) => {
			releaseWait = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await waitReleased;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("should not run"),
		]);
		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;

		await harness.session.steer("steer now", undefined, {
			requestId: "request-steer-abort",
			idempotencyKey: "idem-steer-abort",
		});
		await harness.session.followUp("later", undefined, {
			requestId: "request-follow-abort",
			idempotencyKey: "idem-follow-abort",
		});
		expect(harness.session.getSteeringMessages()).toEqual(["steer now"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["later"]);

		releaseWait?.();
		await harness.session.abort();
		await promptPromise;
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);

		await harness.session.steer("steer now", undefined, {
			requestId: "request-steer-abort-retry",
			idempotencyKey: "idem-steer-abort",
		});
		expect(harness.session.getSteeringMessages()).toEqual(["steer now"]);
		expect(harness.session.lastC2Result).toMatchObject({ status: "accepted", replayed: false });

		await harness.session.followUp("later", undefined, {
			requestId: "request-follow-abort-retry",
			idempotencyKey: "idem-follow-abort",
		});
		expect(harness.session.getFollowUpMessages()).toEqual(["later"]);
		expect(harness.session.lastC2Result).toMatchObject({ status: "accepted", replayed: false });
	});

	it("does not commit a followUp key when a same-text steer is persisted", async () => {
		let releaseWait: (() => void) | undefined;
		const waitReleased = new Promise<void>((resolve) => {
			releaseWait = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await waitReleased;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after steer"),
		]);
		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		const steerPersisted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (
					event.type === "message_end" &&
					event.message.role === "user" &&
					getMessageText(event.message) === "hello"
				) {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;

		await harness.session.followUp("hello", undefined, {
			requestId: "request-follow-same-text",
			idempotencyKey: "idem-follow-same-text",
		});
		await harness.session.steer("hello", undefined, {
			requestId: "request-steer-same-text",
			idempotencyKey: "idem-steer-same-text",
		});

		releaseWait?.();
		await steerPersisted;
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						getMessageText(entry.message) === "hello",
				),
		).toBe(true);
		await harness.session.abort();
		await promptPromise;

		await harness.session.followUp("hello", undefined, {
			requestId: "request-follow-same-text-retry",
			idempotencyKey: "idem-follow-same-text",
		});
		expect(harness.session.getFollowUpMessages()).toEqual(["hello"]);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			replayed: false,
			record: { cause: "followUp", requestId: "request-follow-same-text-retry" },
		});
	});

	it("conflicts a second branch_control that reuses the pre-navigation revision", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("second reply"),
			fauxAssistantMessage("should not run"),
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const originalLeaf = harness.sessionManager.getLeafId();
		const firstUser = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(originalLeaf).toBeTruthy();
		expect(firstUser).toBeDefined();

		const firstNav = await harness.session.navigateTree(firstUser!.id, {
			summarize: false,
			requestId: "request-nav-1",
			idempotencyKey: "idem-nav-1",
		});
		expect(firstNav.cancelled).toBe(false);
		expect(harness.session.lastC2Result?.status).toBe("accepted");
		if (harness.session.lastC2Result?.status !== "accepted") {
			throw new Error("expected first navigation admission");
		}
		const oldRevision = harness.session.lastC2Result.record.baseRevision;

		const returned = await harness.session.navigateTree(originalLeaf!, {
			summarize: false,
			requestId: "request-nav-2",
			idempotencyKey: "idem-nav-2",
		});
		expect(returned.cancelled).toBe(false);
		expect(harness.sessionManager.getLeafId()).toBe(originalLeaf);

		await expect(
			harness.session.navigateTree(firstUser!.id, {
				summarize: false,
				requestId: "request-nav-stale",
				idempotencyKey: "idem-nav-stale",
				baseRevision: oldRevision,
			}),
		).rejects.toBeInstanceOf(C2RefusedError);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "refused",
			code: "revision_conflict",
			operation: "branch_control",
			requestId: "request-nav-stale",
			sideEffect: "none",
		});
		expect(harness.sessionManager.getLeafId()).toBe(originalLeaf);
	});

	it("refuses prompt C2 before extension commands, handled input, flush, and compaction", async () => {
		let commandRuns = 0;
		let inputSeen = 0;
		let compactAttempted = false;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {
							commandRuns += 1;
						},
					});
					pi.on("input", () => {
						inputSeen += 1;
						return { action: "handled" };
					});
					pi.on("session_before_compact", () => {
						compactAttempted = true;
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.agent.state.model = { ...model, contextWindow: 32 };
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: now - 1000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("old reply"),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 500,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const entriesBefore = harness.sessionManager.getEntries().map((entry) => entry.id);

		await expect(
			harness.session.prompt("/testcmd", {
				requestId: "   ",
				idempotencyKey: "idem-command-no-side-effect",
			}),
		).rejects.toBeInstanceOf(C2RefusedError);
		expect(commandRuns).toBe(0);
		expect(inputSeen).toBe(0);
		expect(compactAttempted).toBe(false);
		expect(harness.sessionManager.getEntries().map((entry) => entry.id)).toEqual(entriesBefore);
	});

	it("consumes extension commands through C2 so replay does not re-run them", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should not run")]);

		await harness.session.prompt("/testcmd hello", {
			requestId: "request-cmd",
			idempotencyKey: "idem-cmd",
		});
		expect(commandRuns).toEqual(["hello"]);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			replayed: false,
			record: { cause: "prompt", payload: { text: "/testcmd hello" } },
		});

		await harness.session.prompt("/testcmd hello", {
			requestId: "request-cmd-retry",
			idempotencyKey: "idem-cmd",
		});
		expect(commandRuns).toEqual(["hello"]);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			replayed: true,
		});
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("blocks duplicate native tool execution before the tool runs and keeps JSONL aligned with agent memory", async () => {
		const executed: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				executed.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { text: "a" }, { id: "dup-tool" }),
					fauxToolCall("echo", { text: "b" }, { id: "dup-tool" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(executed).toEqual(["a"]);
		const memoryResults = harness.session.messages.filter((message) => message.role === "toolResult");
		const jsonlResults = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(jsonlResults).toHaveLength(memoryResults.length);
		expect(memoryResults).toHaveLength(2);
		expect(memoryResults[0]).toMatchObject({
			role: "toolResult",
			isError: false,
		});
		expect(memoryResults[1]).toMatchObject({
			role: "toolResult",
			isError: true,
		});
		expect(harness.session.lastC2Result).toMatchObject({
			status: "refused",
			code: "idempotency_conflict",
			sideEffect: "none",
		});
	});

	it("does not share a tool idempotency key across branches after success", async () => {
		const executed: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				executed.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "one" }, { id: "shared-tool" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("after one"),
			fauxAssistantMessage(fauxToolCall("echo", { text: "two" }, { id: "shared-tool" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("after two"),
		]);

		await harness.session.prompt("first", {
			requestId: "request-tool-branch-1",
			idempotencyKey: "idem-tool-branch-1",
		});
		expect(executed).toEqual(["one"]);

		await harness.session.prompt("second", {
			requestId: "request-tool-branch-2",
			idempotencyKey: "idem-tool-branch-2",
		});
		expect(executed).toEqual(["one", "two"]);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			kind: "tool_result",
			replayed: false,
		});
	});

	it("keeps accepted and refused C2 results observable by requestId after later operations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		const c2Events: Array<{ requestId?: string; status: string }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "c2_result") {
				c2Events.push({
					status: event.result.status,
					requestId: event.result.status === "accepted" ? event.result.record.requestId : event.result.requestId,
				});
			}
		});

		await harness.session.prompt("first", {
			requestId: "request-keep-1",
			idempotencyKey: "idem-keep-1",
		});
		await harness.session.prompt("second", {
			requestId: "request-keep-2",
			idempotencyKey: "idem-keep-2",
		});

		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			record: { requestId: "request-keep-2" },
		});
		expect(harness.session.getC2Result("request-keep-1")).toMatchObject({
			status: "accepted",
			record: { requestId: "request-keep-1", payload: { text: "first" } },
		});
		expect(harness.session.getC2Result("request-keep-2")).toMatchObject({
			status: "accepted",
			record: { requestId: "request-keep-2", payload: { text: "second" } },
		});
		expect(c2Events).toEqual([
			{ status: "accepted", requestId: "request-keep-1" },
			{ status: "accepted", requestId: "request-keep-2" },
		]);

		const keep2 = requireAccepted(harness.session.getC2Result("request-keep-2"));
		await expect(
			harness.session.prompt("third", {
				requestId: "request-keep-refused",
				idempotencyKey: "idem-keep-2",
				branchId: keep2.record.branchId,
				baseRevision: keep2.record.baseRevision,
			}),
		).rejects.toBeInstanceOf(C2RefusedError);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "refused",
			requestId: "request-keep-refused",
		});
		expect(harness.session.getC2Result("request-keep-1")).toMatchObject({
			status: "accepted",
			record: { requestId: "request-keep-1" },
		});
		expect(harness.session.getC2Result("request-keep-refused")).toMatchObject({
			status: "refused",
			code: "idempotency_conflict",
			requestId: "request-keep-refused",
		});
		expect(c2Events).toContainEqual({ status: "refused", requestId: "request-keep-refused" });
	});
});
