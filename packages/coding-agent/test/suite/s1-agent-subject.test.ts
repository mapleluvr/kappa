import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentSubjectEvent,
	type AgentSubjectObserveResult,
	createAgentSubject,
} from "../../src/core/agent-subject.ts";
import { C2_EMPTY_LEAF_ID } from "../../src/core/c2-ingress.ts";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { createHarness, type Harness } from "./harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function expectSoon<T>(promise: Promise<T>, ms = 500): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
		}),
	]);
}

function requireObserveOk(result: AgentSubjectObserveResult): Extract<AgentSubjectObserveResult, { kind: "ok" }> {
	if (result.kind !== "ok") {
		throw new Error(`expected observe ok, got ${JSON.stringify(result)}`);
	}
	return result;
}

function expectEnvelope(event: AgentSubjectEvent, sessionId: string): void {
	expect(event.schemaVersion).toBe("s1-draft-1");
	expect(event.eventId.length).toBeGreaterThan(0);
	expect(event.cursor.length).toBeGreaterThan(0);
	expect(event.identity.sessionId).toBe(sessionId);
	expect(event.identity.branchId.length).toBeGreaterThan(0);
	expect(event.identity.revision).toBe(event.revision);
	expect(event.revision).toBeGreaterThanOrEqual(0);
	expect(event.cause.kind.length).toBeGreaterThan(0);
	expect(event.payload).toEqual(expect.any(Object));
	expect(event.provenance).toEqual({ owner: "kappa-agent", source: "native" });
}

describe("S1 Agent Subject facade", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits distinct accepted, running, agent_end, and agent_settled from a real AgentSession prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);
		const subject = createAgentSubject(harness.session, { runId: "run-s1-fixture-0001" });

		const started = subject.start();
		expect(started).toMatchObject({
			kind: "ok",
			identity: {
				runId: "run-s1-fixture-0001",
				sessionId: harness.session.sessionId,
				branchId: C2_EMPTY_LEAF_ID,
				revision: 0,
			},
		});

		const submitted = await subject.submit({
			text: "hi",
			requestId: "request-s1-fixture-0001",
			idempotencyKey: "idem-s1-prompt",
			actor: "operator-fixture-0001",
		});
		expect(submitted).toMatchObject({
			kind: "accepted",
			replayed: false,
			requestId: "request-s1-fixture-0001",
			sessionId: harness.session.sessionId,
		});

		const observed = requireObserveOk(subject.observe());
		const types = observed.events.map((event) => event.type);
		expect(types.filter((type) => type === "agent.accepted")).toHaveLength(1);
		expect(types.filter((type) => type === "agent.running")).toHaveLength(1);
		expect(types.filter((type) => type === "agent.agent_end")).toHaveLength(1);
		expect(types.filter((type) => type === "agent.agent_settled")).toHaveLength(1);
		expect(types.indexOf("agent.accepted")).toBeLessThan(types.indexOf("agent.running"));
		expect(types.indexOf("agent.running")).toBeLessThan(types.indexOf("agent.agent_end"));
		expect(types.indexOf("agent.agent_end")).toBeLessThan(types.indexOf("agent.agent_settled"));

		expect(harness.session.sessionManager.getLeafId()).not.toBe(C2_EMPTY_LEAF_ID);
		for (const event of observed.events) {
			expectEnvelope(event, harness.session.sessionId);
			expect(event.identity.runId).toBe("run-s1-fixture-0001");
			expect(event.identity.requestId).toBe("request-s1-fixture-0001");
			expect(event.identity.branchId).toBe(C2_EMPTY_LEAF_ID);
		}

		const accepted = observed.events.find((event) => event.type === "agent.accepted");
		expect(accepted?.cause).toEqual({ kind: "external_intent", requestId: "request-s1-fixture-0001" });
		expect(accepted?.payload).toMatchObject({
			kind: "user_input",
			replayed: false,
			provenance: { path: "P1.ingress", strategyRef: null },
		});

		const settled = await subject.settled();
		expect(settled).toMatchObject({
			kind: "ok",
			state: "agent_settled",
			event: { type: "agent.agent_settled", identity: { requestId: "request-s1-fixture-0001" } },
		});
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			kind: "user_input",
			record: { provenance: { path: "P1.ingress", strategyRef: null } },
		});
	});

	it("observe(cursor) returns only later events and refuses unknown cursors", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const subject = createAgentSubject(harness.session);
		subject.start();

		await subject.submit({ text: "first", requestId: "request-one" });
		const first = requireObserveOk(subject.observe());
		expect(first.events.length).toBeGreaterThan(0);
		const firstIds = first.events.map((event) => event.eventId);
		expect(new Set(firstIds).size).toBe(firstIds.length);
		const lastCursor = first.cursor;
		expect(lastCursor).toBe(first.events[first.events.length - 1]?.cursor);

		const unchanged = requireObserveOk(subject.observe(lastCursor));
		expect(unchanged.events).toEqual([]);
		expect(unchanged.cursor).toBe(lastCursor);

		await subject.submit({ text: "second", requestId: "request-two" });
		const next = requireObserveOk(subject.observe(lastCursor));
		expect(next.events.length).toBeGreaterThan(0);
		expect(next.events.some((event) => firstIds.includes(event.eventId))).toBe(false);
		expect(next.events[0]?.identity.requestId).toBe("request-two");

		expect(subject.observe("cursor-does-not-exist")).toMatchObject({
			kind: "refused",
			code: "unknown_cursor",
			operation: "observe",
			sideEffect: "none",
			retry: "none",
			reconcile: false,
		});
	});

	it("returns unsupported for operations outside the S1 Agent surface", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const subject = createAgentSubject(harness.session);
		subject.start();

		for (const operation of ["sandboxes.create", "snapshot", "compact", "profiles.inspect"]) {
			expect(await subject.invoke({ type: operation })).toMatchObject({
				kind: "unsupported",
				code: "unsupported_operation",
				operation,
				sideEffect: "none",
				retry: "none",
				reconcile: false,
			});
		}
	});

	it("keeps tool results on existing C2 P2 while S1 facts stay distinct", async () => {
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
		const subject = createAgentSubject(harness.session);
		subject.start();

		await subject.submit({ text: "start", requestId: "request-tool-1" });
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			kind: "tool_result",
			record: {
				source: { kind: "native_tool_execution" },
				provenance: { path: "P2.content", storagePath: "P7.storage.append", strategyRef: null },
			},
		});

		const types = requireObserveOk(subject.observe()).events.map((event) => event.type);
		expect(types.filter((type) => type === "agent.accepted")).toHaveLength(1);
		expect(types).toContain("agent.running");
		expect(types).toContain("agent.agent_end");
		expect(types).toContain("agent.agent_settled");
	});

	it("returns C2 revision_conflict through submit without starting a run", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("should not run")]);
		const subject = createAgentSubject(harness.session);
		subject.start();

		await subject.submit({ text: "first", requestId: "request-first" });
		const pendingBefore = harness.getPendingResponseCount();
		const refused = await subject.submit({
			text: "second",
			requestId: "request-stale",
			idempotencyKey: "idem-stale",
			baseRevision: 0,
		});
		expect(refused).toMatchObject({
			kind: "refused",
			code: "revision_conflict",
			operation: "user_input",
			requestId: "request-stale",
			sessionId: harness.session.sessionId,
			sideEffect: "none",
			retry: "re-read-and-resubmit",
			reconcile: false,
		});
		expect(harness.getPendingResponseCount()).toBe(pendingBefore);
		expect(harness.session.lastC2Result).toMatchObject({ status: "refused", code: "revision_conflict" });

		const types = requireObserveOk(subject.observe()).events.map((event) => event.type);
		expect(types.filter((type) => type === "agent.refused")).toHaveLength(1);
		expect(types.filter((type) => type === "agent.accepted")).toHaveLength(1);
	});

	it("abort settles the native AgentSession path without a TUI wait", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);
		const subject = createAgentSubject(harness.session);
		subject.start();

		const sawRunning = new Promise<void>((resolve) => {
			const timer = setInterval(() => {
				const types = requireObserveOk(subject.observe()).events.map((event) => event.type);
				if (types.includes("agent.running")) {
					clearInterval(timer);
					resolve();
				}
			}, 5);
		});

		const submitted = subject.submit({ text: "hi", requestId: "request-abort" });
		await sawRunning;
		const aborted = await subject.abort();
		expect(aborted).toMatchObject({ kind: "ok" });
		await submitted;

		const settled = await subject.settled();
		expect(settled).toMatchObject({ kind: "ok", state: "agent_settled" });
		const types = requireObserveOk(subject.observe()).events.map((event) => event.type);
		expect(types).toContain("agent.agent_end");
		expect(types).toContain("agent.agent_settled");
		expect(types.indexOf("agent.agent_end")).toBeLessThan(types.indexOf("agent.agent_settled"));
	});

	it("preserves native agent_end and agent_settled on the RPC/print event mapping", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);
		const subject = createAgentSubject(harness.session);
		subject.start();
		await subject.submit({ text: "hi", requestId: "request-rpc-map" });

		const nativeTypes = harness.events.map((event) => event.type);
		expect(nativeTypes).toContain("agent_end");
		expect(nativeTypes).toContain("agent_settled");
		expect(nativeTypes.indexOf("agent_end")).toBeLessThan(nativeTypes.indexOf("agent_settled"));
		expect(toJsonEvent(harness.eventsOfType("agent_end")[0]!).type).toBe("agent_end");
		expect(toJsonEvent(harness.eventsOfType("agent_settled")[0]!).type).toBe("agent_settled");

		const subjectTypes = requireObserveOk(subject.observe()).events.map((event) => event.type);
		expect(subjectTypes).toContain("agent.agent_end");
		expect(subjectTypes).toContain("agent.agent_settled");
		expect(subjectTypes.indexOf("agent.agent_end")).toBeLessThan(subjectTypes.indexOf("agent.agent_settled"));
	});

	it("settled() does not report agent_settled unless that event was observed for the current request", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const subject = createAgentSubject(harness.session, { runId: "run-s1-idle" });
		subject.start();

		const idle = await subject.settled();
		expect(idle.kind).not.toBe("ok");
		expect(idle).not.toMatchObject({ state: "agent_settled" });
		expect(idle).toMatchObject({
			kind: "unknown",
			code: "settlement_not_observed",
			operation: "settled",
			retry: "inspect-before-retry",
			reconcile: true,
		});
		expect("event" in idle ? idle.event : undefined).toBeUndefined();
		expect(requireObserveOk(subject.observe()).events).toEqual([]);
	});

	it("settled() does not return a previous request's agent_settled for a later request", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first")]);
		const subject = createAgentSubject(harness.session, { runId: "run-s1-stale" });
		subject.start();

		await subject.submit({ text: "first", requestId: "request-stale-a" });
		const firstSettled = await subject.settled();
		expect(firstSettled).toMatchObject({
			kind: "ok",
			state: "agent_settled",
			event: { type: "agent.agent_settled", identity: { requestId: "request-stale-a", runId: "run-s1-stale" } },
		});
		if (firstSettled.kind !== "ok") {
			throw new Error("expected first request to settle");
		}
		const previousEventId = firstSettled.event.eventId;

		const previousModel = harness.getModel();
		harness.session.agent.state.model = undefined as unknown as Model<any>;
		const later = await subject.submit({
			text: "second",
			requestId: "request-stale-b",
			idempotencyKey: "idem-stale-b",
		});
		expect(later.kind).not.toBe("accepted");
		harness.session.agent.state.model = previousModel;

		const stale = await subject.settled();
		expect(stale.kind).not.toBe("ok");
		expect(stale).not.toMatchObject({ state: "agent_settled" });
		expect("event" in stale ? stale.event?.eventId : undefined).not.toBe(previousEventId);
		expect("event" in stale ? stale.event : undefined).toBeUndefined();
	});

	it("returns a typed pre-persist result and keeps C2 retryable when prompt fails after admission", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const previousModel = harness.getModel();
		harness.session.agent.state.model = undefined as unknown as Model<any>;
		const subject = createAgentSubject(harness.session);
		subject.start();

		const submitted = await subject.submit({
			text: "hi",
			requestId: "request-unpersisted",
			idempotencyKey: "idem-unpersisted",
		});
		expect(submitted).toMatchObject({
			kind: "refused",
			code: "not_persisted",
			operation: "submit",
			requestId: "request-unpersisted",
			sessionId: harness.session.sessionId,
			sideEffect: "none",
			retry: "re-read-and-resubmit",
			reconcile: false,
		});
		expect(submitted.kind).not.toBe("failed");
		expect(harness.session.messages.filter((message) => message.role === "user")).toEqual([]);
		expect(harness.session.getC2Record("idem-unpersisted")).toBeUndefined();

		const observed = requireObserveOk(subject.observe());
		const types = observed.events.map((event) => event.type);
		expect(types.filter((type) => type === "agent.accepted")).toHaveLength(1);
		expect(types.filter((type) => type === "agent.refused")).toHaveLength(1);
		expect(types).not.toContain("agent.agent_settled");
		const refused = observed.events.find((event) => event.type === "agent.refused");
		expect(refused?.identity.requestId).toBe("request-unpersisted");
		expect(refused?.identity.branchId).toBe(C2_EMPTY_LEAF_ID);
		expect(refused?.payload).toMatchObject({
			code: "not_persisted",
			sideEffect: "none",
			retry: "re-read-and-resubmit",
		});

		harness.session.agent.state.model = previousModel;
		harness.setResponses([fauxAssistantMessage("hello")]);
		const retried = await subject.submit({
			text: "hi",
			requestId: "request-unpersisted",
			idempotencyKey: "idem-unpersisted",
		});
		expect(retried).toMatchObject({
			kind: "accepted",
			replayed: false,
			requestId: "request-unpersisted",
		});
	});

	it("does not emit agent.refused when a live C2 record remains after prompt failure", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;
		const subject = createAgentSubject(harness.session);
		subject.start();
		Object.defineProperty(harness.session, "getC2Record", {
			configurable: true,
			value: () => ({
				kind: "user_input",
				actor: "user",
				requestId: "request-unknown-live",
				sessionId: harness.session.sessionId,
				branchId: C2_EMPTY_LEAF_ID,
				baseRevision: 0,
				source: { kind: "external_user", actorRef: "user" },
				cause: "prompt",
				idempotencyKey: "idem-unknown-live",
				payload: { text: "hi" },
				provenance: { path: "P1.ingress", strategyRef: null },
			}),
		});

		const submitted = await subject.submit({
			text: "hi",
			requestId: "request-unknown-live",
			idempotencyKey: "idem-unknown-live",
		});
		expect(submitted).toMatchObject({
			kind: "unknown",
			code: "not_persisted",
			operation: "submit",
			requestId: "request-unknown-live",
			sessionId: harness.session.sessionId,
			sideEffect: "unknown",
			retry: "inspect-before-retry",
			reconcile: true,
		});

		const observed = requireObserveOk(subject.observe());
		const types = observed.events.map((event) => event.type);
		expect(types.filter((type) => type === "agent.refused")).toHaveLength(0);
		expect(types.filter((type) => type === "agent.unknown")).toHaveLength(1);
		const unknown = observed.events.find((event) => event.type === "agent.unknown");
		expect(unknown?.identity.requestId).toBe("request-unknown-live");
		expect(unknown?.payload).toMatchObject({
			code: "not_persisted",
			operation: "submit",
			sideEffect: "unknown",
			retry: "inspect-before-retry",
		});
	});

	it("pins the accepted request branchId across lifecycle events instead of the later live leaf", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const subject = createAgentSubject(harness.session);
		subject.start();

		await subject.submit({ text: "first", requestId: "request-branch-1" });
		const admittedBranch = harness.session.sessionManager.getLeafId();
		expect(admittedBranch).toEqual(expect.any(String));
		expect(admittedBranch).not.toBe(C2_EMPTY_LEAF_ID);

		await subject.submit({ text: "second", requestId: "request-branch-2" });
		const liveLeaf = harness.session.sessionManager.getLeafId();
		expect(liveLeaf).not.toBe(admittedBranch);

		const observed = requireObserveOk(subject.observe());
		const firstEvents = observed.events.filter((event) => event.identity.requestId === "request-branch-1");
		const secondEvents = observed.events.filter((event) => event.identity.requestId === "request-branch-2");
		expect(firstEvents.map((event) => event.type)).toEqual(
			expect.arrayContaining(["agent.accepted", "agent.running", "agent.agent_end", "agent.agent_settled"]),
		);
		expect(secondEvents.map((event) => event.type)).toEqual(
			expect.arrayContaining(["agent.accepted", "agent.running", "agent.agent_end", "agent.agent_settled"]),
		);
		for (const event of firstEvents) {
			expect(event.identity.branchId).toBe(C2_EMPTY_LEAF_ID);
			expect(event.identity.requestId).toBe("request-branch-1");
			expect(event.revision).toBe(event.identity.revision);
		}
		for (const event of secondEvents) {
			expect(event.identity.branchId).toBe(admittedBranch);
			expect(event.identity.requestId).toBe("request-branch-2");
			expect(event.revision).toBe(event.identity.revision);
		}
	});

	it("returns unknown instead of accepted when getC2Result is missing after prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);
		const subject = createAgentSubject(harness.session);
		subject.start();
		Object.defineProperty(harness.session, "getC2Result", {
			configurable: true,
			value: () => undefined,
		});

		const submitted = await subject.submit({ text: "hi", requestId: "request-missing-c2" });
		expect(submitted.kind).not.toBe("accepted");
		expect(submitted).toMatchObject({
			kind: "unknown",
			code: "c2_result_missing",
			operation: "submit",
			requestId: "request-missing-c2",
			sessionId: harness.session.sessionId,
			retry: "inspect-before-retry",
			reconcile: true,
		});
	});

	it("dispose unsubscribes from AgentSession so later native events are not observed", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const subject = createAgentSubject(harness.session);
		subject.start();

		await subject.submit({ text: "one", requestId: "request-dispose-1" });
		const before = requireObserveOk(subject.observe()).events;
		expect(before.length).toBeGreaterThan(0);

		subject.dispose();
		expect(subject.observe()).toMatchObject({
			kind: "refused",
			code: "not_started",
			operation: "observe",
		});
		await harness.session.prompt("two", { requestId: "request-dispose-2" });
		expect(harness.eventsOfType("agent_settled").length).toBeGreaterThan(1);

		subject.start();
		const after = requireObserveOk(subject.observe()).events;
		expect(after).toHaveLength(before.length);
		expect(after.some((event) => event.identity.requestId === "request-dispose-2")).toBe(false);
	});

	it("refuses an overlapping live submit before admission and keeps A's agent_settled on A", async () => {
		const tool = deferred();
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await tool.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done-a"),
			fauxAssistantMessage("done-b"),
		]);
		const subject = createAgentSubject(harness.session);
		subject.start();

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});

		const submittedA = subject.submit({
			text: "start",
			requestId: "request-overlap-a",
			idempotencyKey: "idem-overlap-a",
		});
		await sawToolStart;

		const submittedB = await subject.submit({
			text: "overlap",
			requestId: "request-overlap-b",
			idempotencyKey: "idem-overlap-b",
		});
		expect(submittedB).toMatchObject({
			kind: "refused",
			code: "request_in_flight",
			operation: "submit",
			requestId: "request-overlap-b",
			sessionId: harness.session.sessionId,
			sideEffect: "none",
			retry: "re-read-and-resubmit",
			reconcile: false,
		});
		expect(harness.session.getC2Result("request-overlap-b")).toBeUndefined();
		expect(harness.session.getC2Record("idem-overlap-b")).toBeUndefined();

		const settledWhileA = subject.settled();
		tool.resolve();
		expect(await submittedA).toMatchObject({
			kind: "accepted",
			requestId: "request-overlap-a",
		});

		const settled = await settledWhileA;
		expect(settled).toMatchObject({
			kind: "ok",
			state: "agent_settled",
			event: { type: "agent.agent_settled", identity: { requestId: "request-overlap-a" } },
		});
		expect("event" in settled ? settled.event.identity.requestId : undefined).toBe("request-overlap-a");

		const observed = requireObserveOk(subject.observe());
		const settledEvents = observed.events.filter((event) => event.type === "agent.agent_settled");
		expect(settledEvents).toHaveLength(1);
		expect(settledEvents[0]?.identity.requestId).toBe("request-overlap-a");
		const bEvents = observed.events.filter((event) => event.identity.requestId === "request-overlap-b");
		expect(bEvents.map((event) => event.type)).toEqual(["agent.refused"]);
		expect(bEvents.some((event) => event.type === "agent.agent_settled")).toBe(false);

		const sequential = await subject.submit({
			text: "after",
			requestId: "request-overlap-b",
			idempotencyKey: "idem-overlap-b",
		});
		expect(sequential).toMatchObject({
			kind: "accepted",
			replayed: false,
			requestId: "request-overlap-b",
		});
	});

	it("refuses a new submit after dispose+start while the previous prompt is still live", async () => {
		const tool = deferred();
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await tool.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done-a"),
			fauxAssistantMessage("done-c"),
		]);
		const subject = createAgentSubject(harness.session);
		subject.start();

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});

		const submittedA = subject.submit({
			text: "start",
			requestId: "request-dispose-inflight-a",
			idempotencyKey: "idem-dispose-inflight-a",
		});
		await sawToolStart;
		const before = requireObserveOk(subject.observe()).events;
		const beforeIds = new Set(before.map((event) => event.eventId));
		expect(before.some((event) => event.identity.requestId === "request-dispose-inflight-a")).toBe(true);

		subject.dispose();
		expect(subject.observe()).toMatchObject({
			kind: "refused",
			code: "not_started",
			operation: "observe",
		});

		subject.start();
		const afterStart = requireObserveOk(subject.observe()).events;
		expect(afterStart).toHaveLength(before.length);
		expect(afterStart.map((event) => event.eventId)).toEqual(before.map((event) => event.eventId));

		const submittedB = await subject.submit({
			text: "overlap",
			requestId: "request-dispose-inflight-b",
			idempotencyKey: "idem-dispose-inflight-b",
		});
		expect(submittedB).toMatchObject({
			kind: "refused",
			code: "request_in_flight",
			operation: "submit",
			requestId: "request-dispose-inflight-b",
			sessionId: harness.session.sessionId,
			sideEffect: "none",
			retry: "re-read-and-resubmit",
			reconcile: false,
		});
		expect(harness.session.getC2Result("request-dispose-inflight-b")).toBeUndefined();
		expect(harness.session.getC2Record("idem-dispose-inflight-b")).toBeUndefined();

		try {
			tool.resolve();
			expect(await submittedA).toMatchObject({
				kind: "accepted",
				requestId: "request-dispose-inflight-a",
			});

			const afterA = requireObserveOk(subject.observe()).events;
			const added = afterA.filter((event) => !beforeIds.has(event.eventId));
			expect(added.every((event) => event.identity.requestId !== "request-dispose-inflight-a")).toBe(true);
			expect(added.some((event) => event.type === "agent.agent_end" || event.type === "agent.agent_settled")).toBe(
				false,
			);
			const bEvents = afterA.filter((event) => event.identity.requestId === "request-dispose-inflight-b");
			expect(bEvents.map((event) => event.type)).toEqual(["agent.refused"]);
			expect(bEvents.some((event) => event.type === "agent.agent_settled")).toBe(false);

			const submittedC = await subject.submit({
				text: "after",
				requestId: "request-dispose-inflight-c",
				idempotencyKey: "idem-dispose-inflight-c",
			});
			expect(submittedC).toMatchObject({
				kind: "accepted",
				replayed: false,
				requestId: "request-dispose-inflight-c",
			});
			const cEvents = requireObserveOk(subject.observe()).events.filter(
				(event) => event.identity.requestId === "request-dispose-inflight-c",
			);
			expect(cEvents.map((event) => event.type)).toEqual(
				expect.arrayContaining(["agent.accepted", "agent.running", "agent.agent_end", "agent.agent_settled"]),
			);
		} finally {
			tool.resolve();
		}
	});

	it("dispose clears the settlement pin so a later start cannot report pre-dispose settlement", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);
		const subject = createAgentSubject(harness.session, { runId: "run-s1-dispose-pin" });
		subject.start();

		await subject.submit({ text: "one", requestId: "request-dispose-pin" });
		const settledBefore = await subject.settled();
		expect(settledBefore).toMatchObject({
			kind: "ok",
			state: "agent_settled",
			event: { type: "agent.agent_settled", identity: { requestId: "request-dispose-pin" } },
		});
		const before = requireObserveOk(subject.observe()).events;
		expect(before.some((event) => event.type === "agent.agent_settled")).toBe(true);

		subject.dispose();
		subject.start();
		const after = requireObserveOk(subject.observe()).events;
		expect(after).toHaveLength(before.length);
		expect(after.map((event) => event.eventId)).toEqual(before.map((event) => event.eventId));

		const settledAfter = await subject.settled();
		expect(settledAfter.kind).not.toBe("ok");
		expect(settledAfter).not.toMatchObject({ state: "agent_settled" });
		expect(settledAfter).toMatchObject({
			kind: "unknown",
			code: "settlement_not_observed",
			operation: "settled",
			retry: "inspect-before-retry",
			reconcile: true,
		});
		expect("event" in settledAfter ? settledAfter.event : undefined).toBeUndefined();

		harness.setResponses([fauxAssistantMessage("two")]);
		const afterIdle = await subject.submit({
			text: "two",
			requestId: "request-dispose-pin-2",
			idempotencyKey: "idem-dispose-pin-2",
		});
		expect(afterIdle).toMatchObject({
			kind: "accepted",
			replayed: false,
			requestId: "request-dispose-pin-2",
		});
		const laterEvents = requireObserveOk(subject.observe()).events.filter(
			(event) => event.identity.requestId === "request-dispose-pin-2",
		);
		expect(laterEvents.map((event) => event.type)).toEqual(
			expect.arrayContaining(["agent.accepted", "agent.running", "agent.agent_end", "agent.agent_settled"]),
		);
	});

	it("invoke submit forwards images on the same C2 path as direct submit", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const image: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "ZmFrZQ==",
		};
		let sawImage = false;
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				sawImage =
					user?.role === "user" &&
					typeof user.content !== "string" &&
					user.content.some((part) => part.type === "image");
				return fauxAssistantMessage("ok");
			},
		]);
		const subject = createAgentSubject(harness.session);
		subject.start();

		const submitted = await subject.invoke({
			type: "submit",
			text: "describe",
			requestId: "request-invoke-image",
			idempotencyKey: "idem-invoke-image",
			images: [image],
		});
		expect(submitted).toMatchObject({
			kind: "accepted",
			requestId: "request-invoke-image",
		});
		expect(sawImage).toBe(true);
		expect(harness.session.lastC2Result).toMatchObject({
			status: "accepted",
			kind: "user_input",
			record: {
				requestId: "request-invoke-image",
				payload: { text: "describe", images: [image] },
			},
		});
		const user = harness.session.messages.find((message) => message.role === "user");
		expect(user?.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png", data: "ZmFrZQ==" })]),
		);
	});

	it("rejects malformed invoke submit images before prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should not run")]);
		const subject = createAgentSubject(harness.session);
		subject.start();
		const pendingBefore = harness.getPendingResponseCount();
		const validImage: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "ZmFrZQ==",
		};
		const malformed = [[{ type: "image" }], [null], ["not-an-image"], [validImage, { type: "text", text: "nope" }]];

		for (const images of malformed) {
			const submitted = await subject.invoke({
				type: "submit",
				text: "describe",
				requestId: "request-bad-image",
				idempotencyKey: "idem-bad-image",
				images,
			});
			expect(submitted).toMatchObject({
				kind: "refused",
				code: "missing_field",
				operation: "submit",
				field: "images",
				sideEffect: "none",
				retry: "none",
				reconcile: false,
			});
		}

		expect(harness.getPendingResponseCount()).toBe(pendingBefore);
		expect(harness.session.messages.filter((message) => message.role === "user")).toEqual([]);
		expect(harness.session.getC2Result("request-bad-image")).toBeUndefined();
		expect(harness.session.getC2Record("idem-bad-image")).toBeUndefined();
	});

	it.skip("settled returns the real agent_settled without waiting on later compaction", async () => {
		const compaction = deferred();
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compaction.promise;
						return {
							compaction: {
								summary: "manual compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const subject = createAgentSubject(harness.session);
		subject.start();

		await subject.submit({ text: "first", requestId: "request-compact-1" });
		await subject.submit({ text: "second", requestId: "request-compact-2" });
		const settledBefore = await subject.settled();
		expect(settledBefore).toMatchObject({
			kind: "ok",
			state: "agent_settled",
			event: { type: "agent.agent_settled", identity: { requestId: "request-compact-2" } },
		});
		if (settledBefore.kind !== "ok") {
			throw new Error("expected agent_settled before compaction");
		}
		const settledCountBefore = requireObserveOk(subject.observe()).events.filter(
			(event) => event.type === "agent.agent_settled",
		).length;

		const compactPromise = harness.session.compact();
		await compactionStarted;
		expect(harness.session.isCompacting).toBe(true);
		expect(harness.session.isIdle).toBe(false);

		try {
			const settledDuring = await expectSoon(subject.settled());
			expect(settledDuring).toMatchObject({
				kind: "ok",
				state: "agent_settled",
				event: {
					type: "agent.agent_settled",
					eventId: settledBefore.event.eventId,
					identity: { requestId: "request-compact-2" },
				},
			});
			const settledCountAfter = requireObserveOk(subject.observe()).events.filter(
				(event) => event.type === "agent.agent_settled",
			).length;
			expect(settledCountAfter).toBe(settledCountBefore);
		} finally {
			compaction.resolve();
			await compactPromise;
		}
	});
});
