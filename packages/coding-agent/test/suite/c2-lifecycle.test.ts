import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { C2_EMPTY_LEAF_ID, C2RefusedError } from "../../src/core/c2-ingress.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function persistedUsers(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
		);
}

describe("C2 queue removal and abort ownership", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("does not commit a prompt when a session listener prevents persistence", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("baseline reply"), fauxAssistantMessage("recovered")]);
		await harness.session.prompt("baseline");
		const branchId = harness.sessionManager.getLeafId()!;
		const identity = { requestId: "write-failed", idempotencyKey: "write-failed", branchId };
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "user") {
				throw new Error("listener failed before persistence");
			}
		});
		try {
			await harness.session.prompt("once", identity);
		} finally {
			unsubscribe();
		}
		expect(persistedUsers(harness)).toEqual(["baseline"]);
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "assistant" && message.errorMessage?.includes("listener failed before persistence"),
			),
		).toBe(true);
		await harness.session.navigateTree(branchId, { summarize: false });
		await harness.session.prompt("once", identity);
		expect(harness.session.getC2Result(identity.requestId)).toMatchObject({ status: "accepted", replayed: false });
		expect(persistedUsers(harness)).toEqual(["baseline", "once"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("refuses duplicate tools before extension tool_call side effects", async () => {
		const hookEffects: string[] = [];
		const executed: string[] = [];
		const parameters = Type.Object({ text: Type.String() });
		const echo: AgentTool<typeof parameters> = {
			name: "echo",
			label: "Echo",
			description: "Echo input",
			parameters,
			execute: async (_id, args) => {
				const text = String(args.text);
				executed.push(text);
				return { content: [{ type: "text", text }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [echo],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event) => {
						if ("text" in event.input) hookEffects.push(String(event.input.text));
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { text: "first" }, { id: "same-call" }),
					fauxToolCall("echo", { text: "duplicate" }, { id: "same-call" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("start");
		expect(executed).toEqual(["first"]);
		expect(hookEffects).toEqual(["first"]);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
	});

	it("clearQueue preserves a prompt waiting for its message_end write", async () => {
		const entered = deferred();
		const release = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "user") {
							entered.resolve();
							await release.promise;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("duplicate")]);
		const identity = { requestId: "clear-active", idempotencyKey: "clear-active", branchId: C2_EMPTY_LEAF_ID };
		const run = harness.session.prompt("once", identity);
		try {
			await entered.promise;
			expect(persistedUsers(harness)).toEqual([]);
			expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: [] });
		} finally {
			release.resolve();
			await run;
		}
		await harness.session.prompt("once", identity);
		expect(harness.session.lastC2Result).toMatchObject({ status: "accepted", replayed: true });
		expect(persistedUsers(harness)).toEqual(["once"]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("clearQueue preserves all messages already drained in all mode", async () => {
		const entered = deferred();
		const release = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_start", async (event) => {
						if (event.message.role === "user" && getMessageText(event.message) === "first queued") {
							entered.resolve();
							await release.promise;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setSteeringMode("all");
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.steer("first queued", undefined, { idempotencyKey: "first" });
		const identity = { requestId: "second", idempotencyKey: "second", branchId: C2_EMPTY_LEAF_ID };
		await harness.session.steer("second queued", undefined, identity);
		const run = harness.session.prompt("start");
		try {
			await entered.promise;
			harness.session.clearQueue();
		} finally {
			release.resolve();
			await run;
		}
		await harness.session.steer("second queued", undefined, identity);
		expect(harness.session.lastC2Result).toMatchObject({ status: "accepted", replayed: true });
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(persistedUsers(harness)).toEqual(["start", "first queued", "second queued"]);
	});

	it("abort keeps an admission pending until its awaited write settles", async () => {
		const entered = deferred();
		const release = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "user") {
							entered.resolve();
							await release.promise;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);
		const identity = { requestId: "abort-write", idempotencyKey: "abort-write", branchId: C2_EMPTY_LEAF_ID };
		const run = harness.session.prompt("once", identity);
		await entered.promise;
		let aborted = false;
		const abort = harness.session.abort().then(() => {
			aborted = true;
		});
		try {
			expect(persistedUsers(harness)).toEqual([]);
			await expect(harness.session.prompt("once", identity)).rejects.toBeInstanceOf(C2RefusedError);
			expect(aborted).toBe(false);
		} finally {
			release.resolve();
			await Promise.all([run, abort]);
		}
		await harness.session.prompt("once", identity);
		expect(harness.session.lastC2Result).toMatchObject({ status: "accepted", replayed: true });
		expect(persistedUsers(harness)).toEqual(["once"]);
	});
});
