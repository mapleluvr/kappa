import { describe, expect, it } from "vitest";
import { C2Ingress, type C2IngressRecord, type C2Refused, type C2Source } from "../src/core/c2-ingress.ts";

function validRecord(overrides: Partial<C2IngressRecord> = {}): C2IngressRecord {
	const kind = overrides.kind ?? "user_input";
	const source: C2Source =
		overrides.source ??
		(kind === "tool_result"
			? { kind: "native_tool_execution", toolCallRef: "tool-call-1" }
			: kind === "branch_control"
				? { kind: "control_intent" }
				: { kind: "external_user", actorRef: "operator-1" });
	const provenance =
		overrides.provenance ??
		(kind === "tool_result"
			? { path: "P2.content", storagePath: "P7.storage.append", strategyRef: null }
			: kind === "branch_control"
				? { path: "P8.storage.structure", strategyRef: null }
				: { path: "P1.ingress", strategyRef: null });
	const payload =
		overrides.payload ??
		(kind === "tool_result"
			? { toolCallId: "tool-call-1", content: [{ type: "text", text: "ok" }] }
			: kind === "branch_control"
				? { targetId: "entry-1", summarize: false }
				: { text: "hello" });
	return {
		kind,
		actor: "operator-1",
		requestId: "request-fixture-0001",
		sessionId: "session-fixture-0001",
		branchId: "branch-main",
		baseRevision: 6,
		source,
		cause: kind === "tool_result" ? "tool-call-1" : kind === "branch_control" ? "navigateTree" : "prompt",
		idempotencyKey: "idem-1",
		payload,
		provenance,
		...overrides,
	};
}

function createIngress(currentRevision = 6): { ingress: C2Ingress; setRevision: (revision: number) => void } {
	let revision = currentRevision;
	return {
		ingress: new C2Ingress({
			getCurrentRevision: () => revision,
		}),
		setRevision: (next) => {
			revision = next;
		},
	};
}

function expectRefused(result: unknown, expected: Partial<C2Refused> & Pick<C2Refused, "code">): void {
	expect(result).toMatchObject({
		status: "refused",
		sideEffect: "none",
		reconcile: false,
		...expected,
	});
}

describe("C2Ingress", () => {
	it("accepts user_input, native tool_result, and branch_control records with identity payload and provenance", () => {
		const { ingress } = createIngress();

		expect(ingress.submit(validRecord({ kind: "user_input" }))).toEqual({
			status: "accepted",
			kind: "user_input",
			replayed: false,
			record: validRecord({ kind: "user_input" }),
		});
		expect(
			ingress.submit(
				validRecord({
					kind: "tool_result",
					requestId: "request-fixture-0002",
					idempotencyKey: "idem-tool",
					baseRevision: 6,
					source: { kind: "native_tool_execution", toolCallRef: "tool-call-fixture-0001" },
					cause: "tool-call-fixture-0001",
					payload: { toolCallId: "tool-call-fixture-0001", content: [{ type: "text", text: "echo" }] },
				}),
			),
		).toMatchObject({
			status: "accepted",
			kind: "tool_result",
			replayed: false,
			record: {
				requestId: "request-fixture-0002",
				source: { kind: "native_tool_execution", toolCallRef: "tool-call-fixture-0001" },
				provenance: { path: "P2.content", storagePath: "P7.storage.append", strategyRef: null },
			},
		});
		expect(
			ingress.submit(
				validRecord({
					kind: "branch_control",
					requestId: "request-fixture-0003",
					idempotencyKey: "idem-branch",
					baseRevision: 6,
					source: { kind: "control_intent" },
					cause: "navigateTree",
					payload: { targetId: "entry-1", summarize: false },
				}),
			),
		).toMatchObject({
			status: "accepted",
			kind: "branch_control",
			replayed: false,
			record: {
				requestId: "request-fixture-0003",
				source: { kind: "control_intent" },
				provenance: { path: "P8.storage.structure", strategyRef: null },
			},
		});
	});

	it("refuses missing required fields including requestId, payload, and baseRevision", () => {
		const { ingress } = createIngress();
		const required = [
			"actor",
			"requestId",
			"sessionId",
			"branchId",
			"source",
			"cause",
			"idempotencyKey",
			"kind",
			"payload",
		] as const;

		for (const field of required) {
			const input = validRecord();
			delete (input as { [key: string]: unknown })[field];
			expectRefused(ingress.submit(input), { code: "missing_field", field });
		}

		const missingRevision = validRecord();
		delete (missingRevision as { baseRevision?: number }).baseRevision;
		expectRefused(ingress.submit(missingRevision), { code: "missing_field", field: "baseRevision" });
	});

	it("refuses blank identity strings", () => {
		const { ingress } = createIngress();
		for (const field of ["actor", "requestId", "sessionId", "branchId", "cause"] as const) {
			expectRefused(ingress.submit(validRecord({ [field]: "  " } as Partial<C2IngressRecord>)), {
				code: "missing_field",
				field,
			});
		}
	});

	it("refuses empty idempotencyKey", () => {
		const { ingress } = createIngress();
		expectRefused(ingress.submit(validRecord({ idempotencyKey: "" })), {
			code: "empty_idempotency_key",
		});
		expectRefused(ingress.submit(validRecord({ idempotencyKey: "   " })), {
			code: "empty_idempotency_key",
		});
	});

	it("refuses a baseRevision that is not a non-negative integer", () => {
		const { ingress } = createIngress();
		for (const baseRevision of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expectRefused(ingress.submit({ ...validRecord(), baseRevision }), {
				code: "invalid_base_revision",
			});
		}
		expectRefused(ingress.submit({ ...validRecord(), baseRevision: "0" as unknown as number }), {
			code: "invalid_base_revision",
		});
	});

	it("refuses unknown kind strings and does not treat steer as a kind", () => {
		const { ingress } = createIngress();
		expectRefused(ingress.submit({ ...validRecord(), kind: "steer" as C2IngressRecord["kind"] }), {
			code: "unknown_kind",
		});
	});

	it("refuses spoofed source kinds and tool results without native toolCallRef", () => {
		const { ingress } = createIngress();
		expectRefused(
			ingress.submit(
				validRecord({
					kind: "user_input",
					source: { kind: "native_tool_execution", toolCallRef: "tool-call-1" },
				}),
			),
			{ code: "missing_field", field: "source" },
		);
		expectRefused(
			ingress.submit(
				validRecord({
					kind: "tool_result",
					source: { kind: "external_user", actorRef: "operator-1" },
					idempotencyKey: "idem-spoofed-tool",
				}),
			),
			{ code: "missing_field", field: "source" },
		);
		expectRefused(
			ingress.submit(
				validRecord({
					kind: "tool_result",
					source: { kind: "native_tool_execution", toolCallRef: "  " },
					idempotencyKey: "idem-blank-ref",
				}),
			),
			{ code: "missing_field", field: "toolCallRef" },
		);
	});

	it("does not treat an admitted key as committed before Pi write", () => {
		const { ingress } = createIngress();
		const record = validRecord();
		expect(ingress.submit(record)).toMatchObject({ status: "accepted", replayed: false });
		expect(ingress.submit({ ...record, requestId: "request-retry" })).not.toMatchObject({
			status: "accepted",
			replayed: true,
		});
	});

	it("replays the same session branch key and payload after commit", () => {
		const { ingress } = createIngress();
		const record = validRecord();
		const first = ingress.submit(record);
		expect(first).toMatchObject({ status: "accepted", replayed: false });
		if (first.status !== "accepted") {
			throw new Error("expected admission");
		}
		ingress.commit(first.record);
		expect(ingress.submit({ ...record, requestId: "request-retry" })).toEqual({
			status: "accepted",
			kind: "user_input",
			replayed: true,
			record: first.record,
		});
	});

	it("allows the same key after release when the Pi write never committed", () => {
		const { ingress } = createIngress();
		const record = validRecord();
		const first = ingress.submit(record);
		expect(first).toMatchObject({ status: "accepted", replayed: false });
		if (first.status !== "accepted") {
			throw new Error("expected admission");
		}
		ingress.release(first.record);
		expect(ingress.submit({ ...record, requestId: "request-retry" })).toMatchObject({
			status: "accepted",
			replayed: false,
		});
	});

	it("refuses the same session branch key with a different payload", () => {
		const { ingress } = createIngress();
		expect(ingress.submit(validRecord({ payload: { text: "one" } }))).toMatchObject({
			status: "accepted",
			replayed: false,
		});
		expectRefused(ingress.submit(validRecord({ payload: { text: "two" } })), {
			code: "idempotency_conflict",
			requestId: "request-fixture-0001",
			sessionId: "session-fixture-0001",
			branchId: "branch-main",
			operation: "user_input",
			retry: "inspect-before-retry",
		});
	});

	it("scopes idempotency to session, branch, and key", () => {
		const { ingress } = createIngress();
		expect(ingress.submit(validRecord({ sessionId: "session-a", branchId: "main" }))).toMatchObject({
			status: "accepted",
			replayed: false,
		});
		expect(
			ingress.submit(validRecord({ sessionId: "session-b", branchId: "main", requestId: "request-b" })),
		).toMatchObject({ status: "accepted", replayed: false });
		expect(
			ingress.submit(validRecord({ sessionId: "session-a", branchId: "other", requestId: "request-c" })),
		).toMatchObject({ status: "accepted", replayed: false });
	});

	it("replays a committed record after the current revision has moved", () => {
		const { ingress, setRevision } = createIngress();
		const record = validRecord();
		const first = ingress.submit(record);
		expect(first).toMatchObject({ status: "accepted", replayed: false });
		if (first.status !== "accepted") {
			throw new Error("expected admission");
		}
		ingress.commit(first.record);
		setRevision(9);
		expect(ingress.submit({ ...record, requestId: "request-retry", baseRevision: 6 })).toEqual({
			status: "accepted",
			kind: "user_input",
			replayed: true,
			record: first.record,
		});
		expect(ingress.submit({ ...record, requestId: "request-retry-current", baseRevision: 9 })).toEqual({
			status: "accepted",
			kind: "user_input",
			replayed: true,
			record: first.record,
		});
	});

	it("replays a committed tool_result after the current revision has moved", () => {
		const { ingress, setRevision } = createIngress();
		const record = validRecord({
			kind: "tool_result",
			source: { kind: "native_tool_execution", toolCallRef: "tool-call-1" },
			cause: "tool-call-1",
			idempotencyKey: "tool-result:tool-call-1",
			payload: { toolCallId: "tool-call-1", toolName: "echo" },
		});
		const first = ingress.submit(record);
		expect(first).toMatchObject({ status: "accepted", replayed: false });
		if (first.status !== "accepted") {
			throw new Error("expected admission");
		}
		ingress.commit(first.record);
		setRevision(9);
		expect(ingress.submit({ ...record, requestId: "request-tool-retry", baseRevision: 6 })).toEqual({
			status: "accepted",
			kind: "tool_result",
			replayed: true,
			record: first.record,
		});
	});

	it("refuses a different canonical record for a committed key after the revision has moved", () => {
		const { ingress, setRevision } = createIngress();
		const first = ingress.submit(validRecord({ payload: { text: "one" } }));
		expect(first).toMatchObject({ status: "accepted", replayed: false });
		if (first.status !== "accepted") {
			throw new Error("expected admission");
		}
		ingress.commit(first.record);
		setRevision(9);
		expectRefused(ingress.submit(validRecord({ payload: { text: "two" }, baseRevision: 6 })), {
			code: "idempotency_conflict",
			requestId: "request-fixture-0001",
			sessionId: "session-fixture-0001",
			branchId: "branch-main",
			operation: "user_input",
			retry: "inspect-before-retry",
		});
	});

	it("does not replay a pending key after the revision has moved", () => {
		const { ingress, setRevision } = createIngress();
		const record = validRecord();
		expect(ingress.submit(record)).toMatchObject({ status: "accepted", replayed: false });
		setRevision(9);
		expectRefused(ingress.submit({ ...record, requestId: "request-retry" }), {
			code: "idempotency_conflict",
			requestId: "request-retry",
			sessionId: "session-fixture-0001",
			branchId: "branch-main",
			operation: "user_input",
			retry: "inspect-before-retry",
		});
	});

	it("still compare-and-swaps new admissions against the current identity revision", () => {
		let currentBranchId = "branch-main";
		let revision = 6;
		const ingress = new C2Ingress({
			getCurrentRevision: (identity) => (identity.branchId === currentBranchId ? revision : -1),
		});
		const record = validRecord();
		const first = ingress.submit(record);
		expect(first).toMatchObject({ status: "accepted", replayed: false });
		if (first.status !== "accepted") {
			throw new Error("expected admission");
		}
		ingress.commit(first.record);
		currentBranchId = "branch-other";
		revision = 8;

		expect(ingress.submit({ ...record, requestId: "request-replay" })).toMatchObject({
			status: "accepted",
			replayed: true,
			record: first.record,
		});
		expectRefused(
			ingress.submit({
				...record,
				requestId: "request-stale-new",
				idempotencyKey: "idem-stale-new",
				baseRevision: 6,
			}),
			{
				code: "revision_conflict",
				requestId: "request-stale-new",
				branchId: "branch-main",
				retry: "re-read-and-resubmit",
			},
		);
	});

	it("commit and release only the admitted record, not a later retry of the same key", () => {
		const { ingress } = createIngress();
		const record = validRecord();
		const first = ingress.submit(record);
		expect(first).toMatchObject({ status: "accepted", replayed: false });
		if (first.status !== "accepted") {
			throw new Error("expected admission");
		}
		ingress.release(first.record);

		const second = ingress.submit({ ...record, requestId: "request-retry" });
		expect(second).toMatchObject({ status: "accepted", replayed: false });
		if (second.status !== "accepted") {
			throw new Error("expected retry admission");
		}

		ingress.release(first.record);
		ingress.commit(first.record);
		expect(ingress.submit({ ...record, requestId: "request-stale-release" })).toMatchObject({
			status: "refused",
			code: "idempotency_conflict",
		});

		ingress.commit(second.record);
		expect(ingress.submit({ ...record, requestId: "request-after-commit" })).toMatchObject({
			status: "accepted",
			replayed: true,
			record: second.record,
		});
	});

	it("refuses stale branch_control against the current revision provider without storing the key", () => {
		const { ingress, setRevision } = createIngress(8);
		const stale = validRecord({
			kind: "branch_control",
			requestId: "request-fixture-0003",
			baseRevision: 5,
			idempotencyKey: "idem-stale-branch",
			source: { kind: "control_intent" },
			cause: "navigateTree",
			payload: { targetId: "entry-1", summarize: false },
		});
		expectRefused(ingress.submit(stale), {
			code: "revision_conflict",
			operation: "branch_control",
			requestId: "request-fixture-0003",
			sessionId: "session-fixture-0001",
			branchId: "branch-main",
			retry: "re-read-and-resubmit",
			sideEffect: "none",
			reconcile: false,
		});

		setRevision(5);
		expect(ingress.submit(stale)).toMatchObject({
			status: "accepted",
			kind: "branch_control",
			replayed: false,
		});
	});
});
