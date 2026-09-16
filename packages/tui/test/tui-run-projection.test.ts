import assert from "node:assert";
import { describe, it } from "node:test";
import {
	inspectTuiRunMutation,
	renderTuiNotice,
	renderTuiRunProjection,
	type TuiEventEnvelope,
	type TuiOutcomeEnvelope,
	TuiRunAttachment,
	type TuiRunFacade,
	type TuiRunFacadeError,
	type TuiRunProjection,
} from "../src/index.ts";
import { visibleWidth } from "../src/utils.ts";

const S1_EVENT: TuiEventEnvelope = {
	schemaVersion: "s1-draft-1",
	eventId: "event-s1-fixture-0001",
	cursor: "cursor-s1-fixture-0001",
	type: "agent.accepted",
	identity: {
		runId: "run-s1-fixture-0001",
		sessionId: "session-s1-fixture-0001",
		branchId: "branch-s1-empty-leaf",
		requestId: "request-s1-fixture-0001",
		revision: 0,
	},
	cause: { kind: "external_intent", requestId: "request-s1-fixture-0001" },
	payload: {},
	provenance: { owner: "kappa-agent", source: "native" },
};

const S1_OUTCOME: TuiOutcomeEnvelope = {
	operationId: "operation-s1-fixture-0001",
	operation: "sandboxes.create",
	identity: {
		runId: "run-s1-fixture-0001",
		requestId: "request-s1-fixture-0001",
		profileId: "wsl2:l1@openshell-docker",
	},
	kind: "refused",
	code: "profile_unverified",
	sideEffects: "none",
	reconcile: false,
};

const S1_PROJECTION = {
	view: "run",
	identity: {
		runId: "run-s1-fixture-0001",
		sessionId: "session-s1-fixture-0001",
		operationId: "operation-s1-fixture-0001",
	},
	revision: 0,
	content: {
		agent: "accepted",
		sandbox: "refused",
		attachment: "degraded",
	},
	provenance: { source: "typed_facade", readOnly: true },
	sourceRange: { cursor: "cursor-s1-fixture-0001" },
	missing: [] as string[],
	warning: { code: "profile_unverified", severity: "warning" },
	readOnly: true,
};

class MemoryRunFacade implements TuiRunFacade {
	private readonly events: readonly TuiEventEnvelope[];
	private readonly outcomeList: readonly TuiOutcomeEnvelope[];
	private readonly ignoreCursor: boolean;

	constructor(
		events: readonly TuiEventEnvelope[],
		outcomeList: readonly TuiOutcomeEnvelope[] = [],
		ignoreCursor = false,
	) {
		this.events = events;
		this.outcomeList = outcomeList;
		this.ignoreCursor = ignoreCursor;
	}

	observe(cursor?: string | null): Iterable<TuiEventEnvelope> {
		if (this.ignoreCursor || cursor == null || cursor === "") {
			return this.events;
		}
		const index = this.events.findIndex((event) => event.cursor === cursor);
		if (index === -1) {
			return this.events;
		}
		return this.events.slice(index + 1);
	}

	outcomes(): Iterable<TuiOutcomeEnvelope> {
		return this.outcomeList;
	}
}

function eventAt(
	cursor: string,
	type: TuiEventEnvelope["type"],
	overrides: Partial<TuiEventEnvelope> = {},
): TuiEventEnvelope {
	return {
		...S1_EVENT,
		eventId: `event-${cursor}`,
		cursor,
		type,
		...overrides,
	};
}

function boxEvent(
	cursor: string,
	type: string,
	payload: unknown,
	overrides: Partial<TuiEventEnvelope> = {},
): TuiEventEnvelope {
	const revision = /^(0|[1-9][0-9]*)$/.test(cursor) ? Number(cursor) : 1;
	return {
		...S1_EVENT,
		eventId: `event-${cursor}`,
		cursor,
		type,
		revision,
		payload,
		identity: {
			...S1_EVENT.identity,
			operationId: S1_OUTCOME.operationId,
			profileId: S1_OUTCOME.identity.profileId,
			revision,
		},
		provenance: { owner: "kappa-box", source: "runtime" },
		...overrides,
	};
}

class ObserveErrorFacade {
	private readonly error: TuiRunFacadeError;

	constructor(error: TuiRunFacadeError) {
		this.error = error;
	}

	observe(cursor?: string | null): TuiRunFacadeError {
		void cursor;
		return this.error;
	}
}

function assertReadOnlyRunProjection(projection: TuiRunProjection): void {
	assert.strictEqual(projection.view, "run");
	assert.strictEqual(projection.readOnly, true);
	assert.strictEqual(projection.provenance.source, "typed_facade");
	assert.strictEqual(projection.provenance.readOnly, true);
	assert.throws(() => {
		const mutable = projection as { readOnly: boolean };
		mutable.readOnly = false;
	});
}

function assertSafeProjectionLines(lines: string[], width: number): void {
	for (const line of lines) {
		assert.strictEqual(/[\u0000-\u001F\u007F-\u009F]/.test(line), false);
		assert.strictEqual(line.includes("\n"), false);
		assert.strictEqual(line.includes("\r"), false);
		assert.strictEqual(visibleWidth(line), width);
	}
}

describe("TuiRunAttachment", () => {
	it("starts detached with a read-only empty run projection and missing identity", () => {
		const attachment = new TuiRunAttachment();
		assert.strictEqual(attachment.state, "detached");
		assert.strictEqual(attachment.cursor, null);
		assert.deepStrictEqual(attachment.appliedEventIds, []);
		const projection = attachment.projection;
		assertReadOnlyRunProjection(projection);
		assert.strictEqual(projection.content.attachment, "detached");
		assert.strictEqual(projection.content.agent, null);
		assert.strictEqual(projection.content.sandbox, null);
		assert.deepStrictEqual(projection.identity, {});
		assert.ok(projection.missing.includes("runId"));
		assert.ok(projection.missing.includes("sessionId"));
		assert.ok(projection.missing.includes("operationId"));
		assert.ok(projection.missing.includes("sourceRange.cursor"));
	});

	it("exposes attaching as a real projection state before facade records are applied", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.beginAttach();
		assert.strictEqual(attachment.state, "attaching");
		assert.strictEqual(projection.content.attachment, "attaching");
		assertReadOnlyRunProjection(projection);
	});

	it("projects the S1 unverified-profile refusal as degraded warning without inventing sandbox ready", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(new MemoryRunFacade([S1_EVENT], [S1_OUTCOME]));
		assert.strictEqual(attachment.state, "degraded");
		assert.deepStrictEqual(projection.view, S1_PROJECTION.view);
		assert.deepStrictEqual(projection.identity, S1_PROJECTION.identity);
		assert.strictEqual(projection.revision, S1_PROJECTION.revision);
		assert.deepStrictEqual(projection.content, S1_PROJECTION.content);
		assert.deepStrictEqual(projection.provenance, S1_PROJECTION.provenance);
		assert.deepStrictEqual(projection.sourceRange, S1_PROJECTION.sourceRange);
		assert.deepStrictEqual(projection.missing, S1_PROJECTION.missing);
		assert.deepStrictEqual(projection.warning, S1_PROJECTION.warning);
		assert.strictEqual(projection.readOnly, true);
		assert.notEqual(projection.content.sandbox, "failed");
		assert.notEqual(projection.content.sandbox, "ready");
		assert.notEqual(projection.sourceRange.cursor, String(projection.revision));
		assert.ok(!("sandboxId" in projection.identity));
		assert.ok(!("factsDigest" in projection.identity));
		assert.ok(!("artifactRef" in projection.identity));
		assert.deepStrictEqual(attachment.appliedEventIds, [S1_EVENT.eventId]);
		assert.deepStrictEqual(attachment.appliedOperationIds, [S1_OUTCOME.operationId]);
	});

	it("does not guess identity fields that the facade omitted", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new MemoryRunFacade([
				{
					...S1_EVENT,
					identity: { revision: 0 },
				},
			]),
		);
		assert.strictEqual(attachment.state, "attached");
		assert.deepStrictEqual(projection.identity, {});
		assert.ok(projection.missing.includes("runId"));
		assert.ok(projection.missing.includes("sessionId"));
		assert.ok(projection.missing.includes("operationId"));
		assert.notEqual(projection.identity.runId, "run-s1-fixture-0001");
	});

	it("reaches attached from detached through attaching when events have no degrading outcome", () => {
		const attachment = new TuiRunAttachment();
		assert.strictEqual(attachment.state, "detached");
		attachment.beginAttach();
		assert.strictEqual(attachment.state, "attaching");
		const projection = attachment.apply(
			new MemoryRunFacade([eventAt("c-accepted", "agent.accepted"), eventAt("c-running", "agent.running")]),
		);
		assert.strictEqual(attachment.state, "attached");
		assert.strictEqual(projection.content.attachment, "attached");
		assert.strictEqual(projection.content.agent, "running");
		assert.strictEqual(projection.content.sandbox, null);
		assert.strictEqual(projection.warning, null);
		assert.strictEqual(projection.sourceRange.cursor, "c-running");
	});

	it("degrades an attached projection when a later profile_unverified outcome arrives", () => {
		const attachment = new TuiRunAttachment();
		attachment.attach(new MemoryRunFacade([eventAt("c-accepted", "agent.accepted")]));
		assert.strictEqual(attachment.state, "attached");
		attachment.beginAttach();
		const projection = attachment.apply(new MemoryRunFacade([], [S1_OUTCOME]));
		assert.strictEqual(attachment.state, "degraded");
		assert.strictEqual(projection.content.attachment, "degraded");
		assert.strictEqual(projection.content.agent, "accepted");
		assert.strictEqual(projection.content.sandbox, "refused");
		assert.deepStrictEqual(projection.warning, { code: "profile_unverified", severity: "warning" });
	});

	it("keeps agent, sandbox, and attachment states independent through agent_settled", () => {
		const attachment = new TuiRunAttachment();
		attachment.attach(new MemoryRunFacade([S1_EVENT], [S1_OUTCOME]));
		const projection = attachment.reattach(
			new MemoryRunFacade([
				eventAt("c-running", "agent.running"),
				eventAt("c-end", "agent.agent_end"),
				eventAt("c-settled", "agent.agent_settled"),
			]),
		);
		assert.strictEqual(projection.content.agent, "agent_settled");
		assert.strictEqual(projection.content.sandbox, "refused");
		assert.strictEqual(projection.content.attachment, "degraded");
		assert.strictEqual(attachment.state, "degraded");
	});

	it("reattaches from cursor without projecting duplicate events", () => {
		const events = [
			eventAt("c1", "agent.accepted"),
			eventAt("c2", "agent.running"),
			eventAt("c3", "agent.agent_end"),
			eventAt("c4", "agent.agent_settled"),
		];
		const facade = new MemoryRunFacade(events);
		const attachment = new TuiRunAttachment();
		attachment.attach(facade);
		assert.deepStrictEqual(attachment.appliedEventIds, ["event-c1", "event-c2", "event-c3", "event-c4"]);
		assert.strictEqual(attachment.cursor, "c4");
		const replayed = attachment.reattach(facade);
		assert.deepStrictEqual(attachment.appliedEventIds, ["event-c1", "event-c2", "event-c3", "event-c4"]);
		assert.strictEqual(replayed.content.agent, "agent_settled");
		assert.strictEqual(replayed.sourceRange.cursor, "c4");
		assert.strictEqual(replayed.content.attachment, "attached");
	});

	it("dedupes overlapping facade replay after reattach", () => {
		const first = eventAt("c1", "agent.accepted");
		const second = eventAt("c2", "agent.running");
		const attachment = new TuiRunAttachment();
		attachment.attach(new MemoryRunFacade([first]));
		const overlapping = new MemoryRunFacade([first, second], [], true);
		const projection = attachment.reattach(overlapping);
		assert.deepStrictEqual(attachment.appliedEventIds, ["event-c1", "event-c2"]);
		assert.strictEqual(projection.content.agent, "running");
		assert.strictEqual(projection.sourceRange.cursor, "c2");
	});

	it("keeps unknown outcomes distinct from failed and does not rewrite them as success", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new MemoryRunFacade(
				[S1_EVENT],
				[
					{
						operationId: "operation-unknown-0001",
						operation: "sandboxes.create",
						identity: { runId: "run-s1-fixture-0001" },
						kind: "unknown",
						code: "host_unreachable",
						sideEffects: "unreconciled",
						reconcile: true,
					},
				],
			),
		);
		assert.strictEqual(projection.content.sandbox, "unknown");
		assert.notEqual(projection.content.sandbox, "failed");
		assert.notEqual(projection.content.sandbox, "ready");
		assert.notEqual(projection.content.sandbox, "refused");
		assert.deepStrictEqual(projection.warning, { code: "host_unreachable", severity: "warning" });
		assert.strictEqual(attachment.state, "degraded");
		assert.strictEqual(projection.readOnly, true);
	});

	it("does not invent sandbox ready or factsDigest when the facade never supplied them", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(new MemoryRunFacade([S1_EVENT], [S1_OUTCOME]));
		assert.notEqual(projection.content.sandbox, "ready");
		assert.ok(!projection.missing.includes("factsDigest"));
		assert.strictEqual(projection.content.sandbox, "refused");
	});

	it("does not publish sandbox ready from a sandbox.ready alias or without factsDigest", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new MemoryRunFacade([
				eventAt("c-ready", "sandbox.ready", {
					identity: {
						runId: "run-s1-fixture-0001",
						sessionId: "session-s1-fixture-0001",
					},
					payload: {},
				}),
			]),
		);
		assert.notEqual(projection.content.sandbox, "ready");
		assert.ok(!projection.missing.includes("factsDigest"));
		assert.ok(projection.missing.includes("operationId"));
		assert.strictEqual(attachment.state, "attached");
	});

	it("latches profile_unverified so a later replayed or unrelated ready cannot publish sandbox=ready", () => {
		const attachment = new TuiRunAttachment();
		attachment.attach(new MemoryRunFacade([S1_EVENT], [S1_OUTCOME]));
		attachment.beginAttach();
		const replayedReady = attachment.apply(
			new MemoryRunFacade([
				boxEvent("3", "box.sandboxes.waitReady", { state: "ready", factsDigest: "sha256:replayed" }),
				eventAt("c-ready", "sandbox.ready", {
					payload: { factsDigest: "sha256:alias" },
				}),
			]),
		);
		assert.strictEqual(replayedReady.content.sandbox, "refused");
		assert.notEqual(replayedReady.content.sandbox, "ready");
		assert.deepStrictEqual(replayedReady.warning, { code: "profile_unverified", severity: "warning" });
		assert.strictEqual(attachment.state, "degraded");

		const mixed = new TuiRunAttachment();
		mixed.attach(new MemoryRunFacade([S1_EVENT], [S1_OUTCOME]));
		mixed.beginAttach();
		const unrelated = mixed.apply(
			new MemoryRunFacade([
				boxEvent(
					"9",
					"box.sandboxes.waitReady",
					{ state: "ready", factsDigest: "sha256:other" },
					{
						identity: {
							runId: "run-other",
							sessionId: "session-other",
							operationId: "operation-other",
							revision: 9,
						},
					},
				),
			]),
		);
		assert.strictEqual(unrelated.identity.runId, "run-s1-fixture-0001");
		assert.strictEqual(unrelated.content.sandbox, "refused");
		assert.notEqual(unrelated.content.sandbox, "ready");
	});

	it("latches sandboxes.delete outcomes so a later matching waitReady cannot publish sandbox=ready", () => {
		const cases: Array<{
			kind: "refused" | "failed" | "unknown";
			code: string;
			sandbox: "refused" | "failed" | "unknown";
			sideEffects: string;
			reconcile: boolean;
		}> = [
			{ kind: "refused", code: "invalid_state", sandbox: "refused", sideEffects: "none", reconcile: false },
			{ kind: "failed", code: "delete_failed", sandbox: "failed", sideEffects: "present", reconcile: false },
			{
				kind: "unknown",
				code: "host_unreachable",
				sandbox: "unknown",
				sideEffects: "unreconciled",
				reconcile: true,
			},
		];
		for (const entry of cases) {
			const deleteOp = `operation-delete-${entry.kind}`;
			const waitOp = `operation-wait-after-delete-${entry.kind}`;
			const attachment = new TuiRunAttachment();
			const afterDelete = attachment.attach(
				new MemoryRunFacade(
					[S1_EVENT],
					[
						{
							operationId: deleteOp,
							operation: "sandboxes.delete",
							identity: {
								runId: "run-s1-fixture-0001",
								sessionId: "session-s1-fixture-0001",
							},
							kind: entry.kind,
							code: entry.code,
							sideEffects: entry.sideEffects,
							reconcile: entry.reconcile,
						},
					],
				),
			);
			assert.strictEqual(afterDelete.content.sandbox, entry.sandbox);
			assert.deepStrictEqual(afterDelete.warning, { code: entry.code, severity: "warning" });
			assert.strictEqual(attachment.state, "degraded");

			attachment.beginAttach();
			const laterReady = attachment.apply(
				new MemoryRunFacade([
					boxEvent(
						"3",
						"box.sandboxes.waitReady",
						{ state: "ready", factsDigest: "sha256:late-delete" },
						{
							identity: {
								runId: "run-s1-fixture-0001",
								sessionId: "session-s1-fixture-0001",
								operationId: waitOp,
								revision: 3,
							},
						},
					),
				]),
			);
			assert.strictEqual(laterReady.content.sandbox, entry.sandbox);
			assert.notEqual(laterReady.content.sandbox, "ready");
			assert.deepStrictEqual(laterReady.warning, { code: entry.code, severity: "warning" });
			assert.strictEqual(attachment.state, "degraded");
			assert.strictEqual(laterReady.identity.runId, "run-s1-fixture-0001");
			assert.strictEqual(laterReady.identity.sessionId, "session-s1-fixture-0001");
			assert.strictEqual(laterReady.identity.operationId, deleteOp);
			assert.ok(!laterReady.missing.includes("factsDigest"));
		}
	});

	it("latches terminal sandbox event states so a later matching waitReady cannot publish sandbox=ready", () => {
		const states = ["failed", "stopped", "expired", "deleted"] as const;
		for (const state of states) {
			const terminalOp = `operation-${state}-0001`;
			const waitOp = `operation-wait-after-${state}`;
			const terminalType = state === "deleted" ? "box.sandboxes.delete" : "box.sandboxes.waitReady";
			const attachment = new TuiRunAttachment();
			const sameBatch = attachment.attach(
				new MemoryRunFacade([
					boxEvent(
						"1",
						"box.sandboxes.create",
						{ state: "provisioning", sandboxId: "sb-1" },
						{
							identity: {
								runId: "run-s1-fixture-0001",
								sessionId: "session-s1-fixture-0001",
								operationId: "operation-create-0001",
								revision: 1,
							},
						},
					),
					boxEvent(
						"2",
						terminalType,
						{ state },
						{
							identity: {
								runId: "run-s1-fixture-0001",
								sessionId: "session-s1-fixture-0001",
								operationId: terminalOp,
								revision: 2,
							},
						},
					),
					boxEvent(
						"3",
						"box.sandboxes.waitReady",
						{ state: "ready", factsDigest: "sha256:late-terminal" },
						{
							identity: {
								runId: "run-s1-fixture-0001",
								sessionId: "session-s1-fixture-0001",
								operationId: waitOp,
								revision: 3,
							},
						},
					),
				]),
			);
			assert.strictEqual(sameBatch.content.sandbox, state);
			assert.notEqual(sameBatch.content.sandbox, "ready");
			assert.strictEqual(sameBatch.warning, null);
			assert.strictEqual(attachment.state, "attached");
			assert.strictEqual(sameBatch.identity.operationId, terminalOp);
			assert.ok(!sameBatch.missing.includes("factsDigest"));

			const phased = new TuiRunAttachment();
			phased.attach(
				new MemoryRunFacade([
					boxEvent(
						"2",
						terminalType,
						{ state },
						{
							identity: {
								runId: "run-s1-fixture-0001",
								sessionId: "session-s1-fixture-0001",
								operationId: terminalOp,
								revision: 2,
							},
						},
					),
				]),
			);
			phased.beginAttach();
			const laterReady = phased.apply(
				new MemoryRunFacade([
					boxEvent(
						"3",
						"box.sandboxes.waitReady",
						{ state: "ready", factsDigest: "sha256:late-terminal" },
						{
							identity: {
								runId: "run-s1-fixture-0001",
								sessionId: "session-s1-fixture-0001",
								operationId: waitOp,
								revision: 3,
							},
						},
					),
				]),
			);
			assert.strictEqual(laterReady.content.sandbox, state);
			assert.notEqual(laterReady.content.sandbox, "ready");
			assert.strictEqual(laterReady.warning, null);
			assert.strictEqual(phased.state, "attached");
			assert.strictEqual(laterReady.identity.operationId, terminalOp);
			assert.ok(!laterReady.missing.includes("factsDigest"));
		}
	});

	it("keeps a terminal sandbox event state when a later waitReady invalid_state outcome arrives", () => {
		const states = ["failed", "stopped", "expired", "deleted"] as const;
		for (const state of states) {
			const terminalOp = `operation-${state}-terminal-0001`;
			const waitOp = `operation-wait-invalid-after-${state}`;
			const terminalType = state === "deleted" ? "box.sandboxes.delete" : "box.sandboxes.waitReady";
			const invalidOutcome: TuiOutcomeEnvelope = {
				operationId: waitOp,
				operation: "sandboxes.waitReady",
				identity: {
					runId: "run-s1-fixture-0001",
					sessionId: "session-s1-fixture-0001",
				},
				kind: "refused",
				code: "invalid_state",
				sideEffects: "none",
				reconcile: false,
			};
			const sameBatch = new TuiRunAttachment();
			const sameProjection = sameBatch.attach(
				new MemoryRunFacade(
					[
						boxEvent(
							"1",
							"box.sandboxes.create",
							{ state: "provisioning", sandboxId: "sb-1" },
							{
								identity: {
									runId: "run-s1-fixture-0001",
									sessionId: "session-s1-fixture-0001",
									operationId: "operation-create-0001",
									revision: 1,
								},
							},
						),
						boxEvent(
							"2",
							terminalType,
							{ state },
							{
								identity: {
									runId: "run-s1-fixture-0001",
									sessionId: "session-s1-fixture-0001",
									operationId: terminalOp,
									revision: 2,
								},
							},
						),
					],
					[invalidOutcome],
				),
			);
			assert.strictEqual(sameProjection.content.sandbox, state);
			assert.notEqual(sameProjection.content.sandbox, "refused");
			assert.notEqual(sameProjection.content.sandbox, "ready");
			assert.strictEqual(sameProjection.identity.operationId, terminalOp);
			assert.strictEqual(sameProjection.warning, null);
			assert.strictEqual(sameBatch.state, "attached");

			const phased = new TuiRunAttachment();
			phased.attach(
				new MemoryRunFacade([
					boxEvent(
						"2",
						terminalType,
						{ state },
						{
							identity: {
								runId: "run-s1-fixture-0001",
								sessionId: "session-s1-fixture-0001",
								operationId: terminalOp,
								revision: 2,
							},
						},
					),
				]),
			);
			phased.beginAttach();
			const laterInvalid = phased.apply(new MemoryRunFacade([], [invalidOutcome]));
			assert.strictEqual(laterInvalid.content.sandbox, state);
			assert.notEqual(laterInvalid.content.sandbox, "refused");
			assert.notEqual(laterInvalid.content.sandbox, "ready");
			assert.strictEqual(laterInvalid.identity.operationId, terminalOp);
			assert.strictEqual(laterInvalid.warning, null);
			assert.strictEqual(phased.state, "attached");
		}
	});

	it("publishes sandbox ready only from matching waitReady success with factsDigest", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new MemoryRunFacade([
				boxEvent("1", "box.sandboxes.create", { state: "provisioning", sandboxId: "sb-1" }),
				boxEvent("2", "box.sandboxes.waitReady", { state: "ready", factsDigest: "sha256:facts-1" }),
			]),
		);
		assert.strictEqual(projection.content.sandbox, "ready");
		assert.ok(!projection.missing.includes("factsDigest"));
		assert.strictEqual(attachment.state, "attached");
		assert.strictEqual(projection.readOnly, true);

		const withoutDigest = new TuiRunAttachment();
		const blocked = withoutDigest.attach(
			new MemoryRunFacade([
				boxEvent("1", "box.sandboxes.create", { state: "provisioning", sandboxId: "sb-1" }),
				boxEvent("2", "box.sandboxes.waitReady", { state: "ready", factsDigest: null }),
			]),
		);
		assert.notEqual(blocked.content.sandbox, "ready");
		assert.strictEqual(blocked.content.sandbox, "provisioning");
		assert.ok(blocked.missing.includes("factsDigest"));
	});

	it("maps box.sandboxes.create payload refusal without inventing ready", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new MemoryRunFacade([
				S1_EVENT,
				boxEvent("2", "box.sandboxes.create", {
					kind: "refused",
					code: "profile_unverified",
					sideEffects: "none",
					reconcile: false,
				}),
			]),
		);
		assert.strictEqual(projection.content.sandbox, "refused");
		assert.deepStrictEqual(projection.warning, { code: "profile_unverified", severity: "warning" });
		assert.strictEqual(attachment.state, "degraded");
		assert.notEqual(projection.content.sandbox, "ready");
	});

	it("projects lifecycle outcomes only and keeps the first stronger refusal over follow-on invalid_state", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new MemoryRunFacade(
				[S1_EVENT],
				[
					S1_OUTCOME,
					{
						operationId: "operation-wait-0002",
						operation: "sandboxes.waitReady",
						identity: { runId: "run-s1-fixture-0001" },
						kind: "refused",
						code: "invalid_state",
						sideEffects: "none",
						reconcile: false,
					},
					{
						operationId: "operation-exec-0003",
						operation: "exec",
						identity: { runId: "run-s1-fixture-0001" },
						kind: "failed",
						code: "provisioning_failed",
						sideEffects: "present",
						reconcile: false,
					},
					{
						operationId: "operation-inspect-0004",
						operation: "profiles.inspect",
						identity: { runId: "run-s1-fixture-0001" },
						kind: "refused",
						code: "profile_unknown",
						sideEffects: "none",
						reconcile: false,
					},
				],
			),
		);
		assert.strictEqual(projection.content.sandbox, "refused");
		assert.deepStrictEqual(projection.warning, { code: "profile_unverified", severity: "warning" });
		assert.notEqual(projection.warning?.code, "identity_mismatch");
		assert.strictEqual(projection.identity.operationId, S1_OUTCOME.operationId);
		assert.notEqual(projection.content.sandbox, "failed");
		assert.deepStrictEqual(attachment.appliedOperationIds, [
			S1_OUTCOME.operationId,
			"operation-wait-0002",
			"operation-exec-0003",
			"operation-inspect-0004",
		]);
	});

	it("keeps unknown distinct when a later invalid_state outcome arrives", () => {
		const attachment = new TuiRunAttachment();
		attachment.attach(
			new MemoryRunFacade(
				[S1_EVENT],
				[
					{
						operationId: "operation-unknown-0001",
						operation: "sandboxes.create",
						identity: { runId: "run-s1-fixture-0001" },
						kind: "unknown",
						code: "host_unreachable",
						sideEffects: "unreconciled",
						reconcile: true,
					},
				],
			),
		);
		attachment.beginAttach();
		const projection = attachment.apply(
			new MemoryRunFacade(
				[],
				[
					{
						operationId: "operation-wait-0002",
						operation: "sandboxes.waitReady",
						identity: { runId: "run-s1-fixture-0001" },
						kind: "refused",
						code: "invalid_state",
						sideEffects: "none",
						reconcile: false,
					},
				],
			),
		);
		assert.strictEqual(projection.content.sandbox, "unknown");
		assert.deepStrictEqual(projection.warning, { code: "host_unreachable", severity: "warning" });
	});

	it("keeps delete failed and unknown warning semantics when a later waitReady invalid_state arrives", () => {
		const cases: Array<{
			kind: "failed" | "unknown";
			code: string;
			sandbox: "failed" | "unknown";
			sideEffects: string;
			reconcile: boolean;
		}> = [
			{ kind: "failed", code: "delete_failed", sandbox: "failed", sideEffects: "present", reconcile: false },
			{
				kind: "unknown",
				code: "host_unreachable",
				sandbox: "unknown",
				sideEffects: "unreconciled",
				reconcile: true,
			},
		];
		for (const entry of cases) {
			const deleteOp = `operation-delete-${entry.kind}-keep-warning`;
			const waitOp = `operation-wait-after-delete-${entry.kind}-invalid`;
			const attachment = new TuiRunAttachment();
			const afterDelete = attachment.attach(
				new MemoryRunFacade(
					[S1_EVENT],
					[
						{
							operationId: deleteOp,
							operation: "sandboxes.delete",
							identity: {
								runId: "run-s1-fixture-0001",
								sessionId: "session-s1-fixture-0001",
							},
							kind: entry.kind,
							code: entry.code,
							sideEffects: entry.sideEffects,
							reconcile: entry.reconcile,
						},
					],
				),
			);
			assert.strictEqual(afterDelete.content.sandbox, entry.sandbox);
			assert.deepStrictEqual(afterDelete.warning, { code: entry.code, severity: "warning" });
			assert.strictEqual(afterDelete.identity.operationId, deleteOp);

			attachment.beginAttach();
			const laterInvalid = attachment.apply(
				new MemoryRunFacade(
					[],
					[
						{
							operationId: waitOp,
							operation: "sandboxes.waitReady",
							identity: {
								runId: "run-s1-fixture-0001",
								sessionId: "session-s1-fixture-0001",
							},
							kind: "refused",
							code: "invalid_state",
							sideEffects: "none",
							reconcile: false,
						},
					],
				),
			);
			assert.strictEqual(laterInvalid.content.sandbox, entry.sandbox);
			assert.notEqual(laterInvalid.content.sandbox, "refused");
			assert.notEqual(laterInvalid.content.sandbox, "ready");
			assert.deepStrictEqual(laterInvalid.warning, { code: entry.code, severity: "warning" });
			assert.strictEqual(laterInvalid.identity.operationId, deleteOp);
			assert.strictEqual(attachment.state, "degraded");
		}
	});

	it("binds the first run/session/operation identity and degrades mismatches", () => {
		const attachment = new TuiRunAttachment();
		attachment.attach(
			new MemoryRunFacade([
				eventAt("1", "agent.accepted", {
					revision: 1,
					identity: {
						runId: "run-a",
						sessionId: "session-a",
						operationId: "operation-a",
						revision: 1,
					},
				}),
			]),
		);
		attachment.beginAttach();
		const projection = attachment.apply(
			new MemoryRunFacade([
				eventAt("2", "agent.running", {
					revision: 2,
					identity: {
						runId: "run-b",
						sessionId: "session-b",
						operationId: "operation-b",
						revision: 2,
					},
				}),
			]),
		);
		assert.deepStrictEqual(projection.identity, {
			runId: "run-a",
			sessionId: "session-a",
			operationId: "operation-a",
		});
		assert.strictEqual(projection.content.agent, "accepted");
		assert.strictEqual(attachment.state, "degraded");
		assert.deepStrictEqual(projection.warning, { code: "identity_mismatch", severity: "warning" });
		assert.deepStrictEqual(attachment.appliedEventIds, ["event-1"]);
		assert.deepStrictEqual(attachment.appliedOperationIds, ["operation-a"]);
	});

	it("accepts distinct Box operationIds in one run and projects the current lifecycle operation", () => {
		const createOp = "operation-create-0001";
		const waitOp = "operation-wait-0002";
		const execOp = "operation-exec-0003";
		const collectOp = "operation-collect-0004";
		const deleteOp = "operation-delete-0005";
		const attachment = new TuiRunAttachment();
		const ready = attachment.attach(
			new MemoryRunFacade([
				boxEvent(
					"1",
					"box.sandboxes.create",
					{ state: "provisioning", sandboxId: "sb-1" },
					{
						identity: {
							runId: "run-s1-fixture-0001",
							sessionId: "session-s1-fixture-0001",
							operationId: createOp,
							revision: 1,
						},
					},
				),
				boxEvent(
					"2",
					"box.sandboxes.waitReady",
					{ state: "ready", factsDigest: "sha256:facts-1" },
					{
						identity: {
							runId: "run-s1-fixture-0001",
							sessionId: "session-s1-fixture-0001",
							operationId: waitOp,
							revision: 2,
						},
					},
				),
			]),
		);
		assert.strictEqual(attachment.state, "attached");
		assert.strictEqual(ready.warning, null);
		assert.strictEqual(ready.content.sandbox, "ready");
		assert.strictEqual(ready.identity.runId, "run-s1-fixture-0001");
		assert.strictEqual(ready.identity.sessionId, "session-s1-fixture-0001");
		assert.strictEqual(ready.identity.operationId, waitOp);
		assert.deepStrictEqual(attachment.appliedOperationIds, [createOp, waitOp]);
		assert.ok(!ready.missing.includes("factsDigest"));

		attachment.beginAttach();
		const projection = attachment.apply(
			new MemoryRunFacade([
				boxEvent(
					"3",
					"box.exec",
					{ exitCode: 0 },
					{
						identity: {
							runId: "run-s1-fixture-0001",
							sessionId: "session-s1-fixture-0001",
							operationId: execOp,
							revision: 3,
						},
					},
				),
				boxEvent(
					"4",
					"box.collect",
					{ artifactRef: "artifact-1" },
					{
						identity: {
							runId: "run-s1-fixture-0001",
							sessionId: "session-s1-fixture-0001",
							operationId: collectOp,
							revision: 4,
						},
					},
				),
				boxEvent(
					"5",
					"box.sandboxes.delete",
					{ state: "deleted" },
					{
						identity: {
							runId: "run-s1-fixture-0001",
							sessionId: "session-s1-fixture-0001",
							operationId: deleteOp,
							revision: 5,
						},
					},
				),
			]),
		);
		assert.strictEqual(attachment.state, "attached");
		assert.strictEqual(projection.warning, null);
		assert.strictEqual(projection.content.sandbox, "deleted");
		assert.strictEqual(projection.identity.runId, "run-s1-fixture-0001");
		assert.strictEqual(projection.identity.sessionId, "session-s1-fixture-0001");
		assert.strictEqual(projection.identity.operationId, deleteOp);
		assert.deepStrictEqual(attachment.appliedOperationIds, [createOp, waitOp, execOp, collectOp, deleteOp]);
		assert.ok(!("sandboxId" in projection.identity));
		assert.ok(!("factsDigest" in projection.identity));
		assert.ok(!("artifactRef" in projection.identity));
		assert.strictEqual(projection.readOnly, true);
	});

	it("degrades a cross-run mismatch without overwriting the bound run identity", () => {
		const attachment = new TuiRunAttachment();
		attachment.attach(
			new MemoryRunFacade([
				boxEvent(
					"1",
					"box.sandboxes.create",
					{ state: "provisioning", sandboxId: "sb-a" },
					{
						identity: {
							runId: "run-a",
							sessionId: "session-a",
							operationId: "operation-a",
							revision: 1,
						},
					},
				),
			]),
		);
		attachment.beginAttach();
		const projection = attachment.apply(
			new MemoryRunFacade([
				boxEvent(
					"2",
					"box.sandboxes.waitReady",
					{ state: "ready", factsDigest: "sha256:other" },
					{
						identity: {
							runId: "run-b",
							sessionId: "session-b",
							operationId: "operation-b",
							revision: 2,
						},
					},
				),
			]),
		);
		assert.deepStrictEqual(projection.identity, {
			runId: "run-a",
			sessionId: "session-a",
			operationId: "operation-a",
		});
		assert.strictEqual(projection.content.sandbox, "provisioning");
		assert.notEqual(projection.content.sandbox, "ready");
		assert.strictEqual(attachment.state, "degraded");
		assert.deepStrictEqual(projection.warning, { code: "identity_mismatch", severity: "warning" });
		assert.deepStrictEqual(attachment.appliedEventIds, ["event-1"]);
		assert.deepStrictEqual(attachment.appliedOperationIds, ["operation-a"]);
	});

	it("omits identity-rejected events from appliedEventIds and still dedupes them on replay", () => {
		const bound = eventAt("1", "agent.accepted", {
			revision: 1,
			identity: {
				runId: "run-a",
				sessionId: "session-a",
				operationId: "operation-a",
				revision: 1,
			},
		});
		const mismatched = eventAt("2", "agent.running", {
			revision: 2,
			identity: {
				runId: "run-b",
				sessionId: "session-b",
				operationId: "operation-b",
				revision: 2,
			},
		});
		const laterMatching = eventAt("3", "agent.agent_end", {
			revision: 3,
			identity: {
				runId: "run-a",
				sessionId: "session-a",
				operationId: "operation-a",
				revision: 3,
			},
		});
		const attachment = new TuiRunAttachment();
		const first = attachment.attach(new MemoryRunFacade([bound, mismatched]));
		assert.deepStrictEqual(attachment.appliedEventIds, ["event-1"]);
		assert.deepStrictEqual(attachment.appliedOperationIds, ["operation-a"]);
		assert.strictEqual(first.content.agent, "accepted");
		assert.deepStrictEqual(first.identity, {
			runId: "run-a",
			sessionId: "session-a",
			operationId: "operation-a",
		});
		assert.deepStrictEqual(first.warning, { code: "identity_mismatch", severity: "warning" });

		attachment.beginAttach();
		const replayed = attachment.apply(new MemoryRunFacade([bound, mismatched, laterMatching], [], true));
		assert.deepStrictEqual(attachment.appliedEventIds, ["event-1", "event-3"]);
		assert.deepStrictEqual(attachment.appliedOperationIds, ["operation-a"]);
		assert.strictEqual(replayed.content.agent, "agent_end");
		assert.deepStrictEqual(replayed.identity, {
			runId: "run-a",
			sessionId: "session-a",
			operationId: "operation-a",
		});
		assert.deepStrictEqual(replayed.warning, { code: "identity_mismatch", severity: "warning" });
		assert.strictEqual(attachment.state, "degraded");
		assert.strictEqual(replayed.sourceRange.cursor, "3");
	});

	it("resets identity, cursor, and seen sets on detach so a new run can reuse the attachment", () => {
		const attachment = new TuiRunAttachment();
		attachment.attach(
			new MemoryRunFacade([
				eventAt("1", "agent.accepted", {
					revision: 1,
					identity: {
						runId: "run-a",
						sessionId: "session-a",
						operationId: "operation-a",
						revision: 1,
					},
				}),
			]),
		);
		const detached = attachment.detach();
		assert.strictEqual(attachment.state, "detached");
		assert.strictEqual(attachment.cursor, null);
		assert.deepStrictEqual(attachment.appliedEventIds, []);
		assert.deepStrictEqual(attachment.appliedOperationIds, []);
		assert.deepStrictEqual(detached.identity, {});
		assert.strictEqual(detached.content.agent, null);
		assert.strictEqual(detached.sourceRange.cursor, null);

		const reused = attachment.attach(
			new MemoryRunFacade([
				eventAt("1", "agent.running", {
					revision: 1,
					identity: {
						runId: "run-b",
						sessionId: "session-b",
						operationId: "operation-b",
						revision: 1,
					},
				}),
			]),
		);
		assert.deepStrictEqual(reused.identity, {
			runId: "run-b",
			sessionId: "session-b",
			operationId: "operation-b",
		});
		assert.strictEqual(reused.content.agent, "running");
		assert.strictEqual(reused.content.attachment, "attached");
		assert.strictEqual(attachment.cursor, "1");
	});

	it("does not move the resume cursor backwards and does not treat cursor as a revision alias", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new MemoryRunFacade([
				eventAt("3", "agent.accepted", {
					revision: 10,
					identity: {
						...S1_EVENT.identity,
						revision: 10,
					},
				}),
				eventAt("1", "agent.running", {
					revision: 1,
					identity: {
						...S1_EVENT.identity,
						revision: 1,
					},
				}),
				eventAt("4", "agent.agent_end", {
					revision: 4,
					identity: {
						...S1_EVENT.identity,
						revision: 4,
					},
				}),
			]),
		);
		assert.strictEqual(projection.sourceRange.cursor, "4");
		assert.strictEqual(projection.revision, 10);
		assert.notEqual(projection.sourceRange.cursor, String(projection.revision));
		assert.strictEqual(projection.content.agent, "agent_end");
	});

	it("maps agent.refused without inventing an agent run state", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new MemoryRunFacade([
				eventAt("1", "agent.refused", {
					payload: { code: "revision_conflict", operation: "user_input" },
				}),
			]),
		);
		assert.strictEqual(projection.content.agent, null);
		assert.strictEqual(attachment.state, "degraded");
		assert.deepStrictEqual(projection.warning, { code: "revision_conflict", severity: "warning" });
	});

	it("maps agent.unknown as degraded warning without rewriting agent or sandbox state", () => {
		const acceptedOp = "operation-accepted-0001";
		const unknownOp = "operation-unknown-0001";
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new MemoryRunFacade([
				eventAt("1", "agent.accepted", {
					revision: 1,
					identity: {
						runId: "run-s1-fixture-0001",
						sessionId: "session-s1-fixture-0001",
						operationId: acceptedOp,
						revision: 1,
					},
				}),
				boxEvent(
					"2",
					"box.sandboxes.create",
					{ state: "provisioning", sandboxId: "sb-1" },
					{
						identity: {
							runId: "run-s1-fixture-0001",
							sessionId: "session-s1-fixture-0001",
							operationId: acceptedOp,
							revision: 2,
						},
					},
				),
				eventAt("3", "agent.unknown", {
					revision: 3,
					payload: {
						code: "not_persisted",
						operation: "submit",
						sideEffect: "unknown",
						retry: "inspect-before-retry",
					},
					identity: {
						runId: "run-s1-fixture-0001",
						sessionId: "session-s1-fixture-0001",
						operationId: unknownOp,
						revision: 3,
					},
				}),
			]),
		);
		assertReadOnlyRunProjection(projection);
		assert.strictEqual(projection.content.agent, "accepted");
		assert.notEqual(projection.content.agent, "running");
		assert.notEqual(projection.content.agent, "agent_end");
		assert.notEqual(projection.content.agent, "agent_settled");
		assert.strictEqual(projection.content.sandbox, "provisioning");
		assert.notEqual(projection.content.sandbox, "refused");
		assert.notEqual(projection.content.sandbox, "unknown");
		assert.notEqual(projection.content.sandbox, "failed");
		assert.strictEqual(projection.content.attachment, "degraded");
		assert.strictEqual(attachment.state, "degraded");
		assert.deepStrictEqual(projection.warning, { code: "not_persisted", severity: "warning" });
		assert.notEqual(projection.warning?.code, "agent.refused");
		assert.deepStrictEqual(projection.identity, {
			runId: "run-s1-fixture-0001",
			sessionId: "session-s1-fixture-0001",
			operationId: acceptedOp,
		});
		assert.strictEqual(projection.sourceRange.cursor, "3");
		assert.strictEqual(projection.revision, 3);
		assert.deepStrictEqual(attachment.appliedEventIds, ["event-1", "event-2", "event-3"]);
		assert.deepStrictEqual(attachment.appliedOperationIds, [acceptedOp, unknownOp]);
		assert.deepStrictEqual(inspectTuiRunMutation("submit"), { supported: false, readOnly: true });
		const text = renderTuiRunProjection(projection, 80).join("\n");
		assert.ok(text.includes("agent: accepted"));
		assert.ok(text.includes("sandbox: provisioning"));
		assert.ok(text.includes("attachment: degraded"));
		assert.ok(text.includes("not_persisted"));
		assert.strictEqual(text.includes("sandbox: refused"), false);

		const fallback = new TuiRunAttachment();
		const missingCode = fallback.attach(new MemoryRunFacade([eventAt("1", "agent.unknown", { payload: {} })]));
		assertReadOnlyRunProjection(missingCode);
		assert.strictEqual(missingCode.content.agent, null);
		assert.notEqual(missingCode.content.agent, "accepted");
		assert.notEqual(missingCode.content.agent, "running");
		assert.notEqual(missingCode.content.agent, "agent_end");
		assert.notEqual(missingCode.content.agent, "agent_settled");
		assert.strictEqual(missingCode.content.sandbox, null);
		assert.notEqual(missingCode.content.sandbox, "refused");
		assert.strictEqual(fallback.state, "degraded");
		assert.deepStrictEqual(missingCode.warning, { code: "agent.unknown", severity: "warning" });
		assert.notEqual(missingCode.warning?.code, "agent.refused");
		assert.strictEqual(missingCode.sourceRange.cursor, "1");
		assert.deepStrictEqual(fallback.appliedEventIds, ["event-1"]);
	});

	it("does not take factsDigest from arbitrary events", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new MemoryRunFacade([
				eventAt("1", "agent.accepted", {
					payload: { factsDigest: "sha256:stolen" },
				}),
				boxEvent("2", "box.sandboxes.waitReady", { state: "ready" }),
			]),
		);
		assert.notEqual(projection.content.sandbox, "ready");
		assert.ok(projection.missing.includes("factsDigest"));
	});

	it("leaves the attachment recoverable when observe throws", () => {
		const attachment = new TuiRunAttachment();
		attachment.attach(new MemoryRunFacade([eventAt("1", "agent.accepted")]));
		assert.strictEqual(attachment.state, "attached");
		const prior = attachment.projection;
		attachment.beginAttach();
		const recovered = attachment.apply({
			observe() {
				throw new Error("facade down");
			},
		});
		assert.notEqual(attachment.state, "attaching");
		assert.strictEqual(attachment.state, "degraded");
		assert.strictEqual(recovered.content.agent, prior.content.agent);
		assert.strictEqual(recovered.identity.runId, prior.identity.runId);
		assert.deepStrictEqual(recovered.warning, { code: "observe_failed", severity: "warning" });
		attachment.beginAttach();
		assert.strictEqual(attachment.state, "attaching");
	});

	it("represents a typed facade observe error instead of treating it as quiet success", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new ObserveErrorFacade({
				kind: "refused",
				code: "unknown_cursor",
				operation: "observe",
				sideEffect: "none",
				retry: "none",
				reconcile: false,
			}),
		);
		assert.notEqual(attachment.state, "attaching");
		assert.strictEqual(attachment.state, "degraded");
		assert.strictEqual(projection.content.agent, null);
		assert.deepStrictEqual(projection.warning, { code: "unknown_cursor", severity: "warning" });
		assert.ok(projection.missing.includes("runId"));
	});

	it("throws when apply is called while detached", () => {
		const attachment = new TuiRunAttachment();
		assert.throws(() => attachment.apply(new MemoryRunFacade([S1_EVENT])), /attaching/);
	});

	it("does not expose stop, delete, or settle mutation on the attachment", () => {
		const attachment = new TuiRunAttachment();
		assert.strictEqual("stop" in attachment, false);
		assert.strictEqual("delete" in attachment, false);
		assert.strictEqual("settle" in attachment, false);
		assert.strictEqual("abort" in attachment, false);
		assert.strictEqual("create" in attachment, false);
		assert.strictEqual(typeof inspectTuiRunMutation, "function");
		for (const command of ["stop", "delete", "settle", "abort", "create", "exec", "collect", "submit", "start"]) {
			assert.deepStrictEqual(inspectTuiRunMutation(command), { supported: false, readOnly: true });
		}
	});
});

describe("renderTuiRunProjection", () => {
	it("renders identity, states, warning, missing fields, and source cursor", () => {
		const attachment = new TuiRunAttachment();
		const missingLines = renderTuiRunProjection(attachment.projection, 80);
		const missingText = missingLines.join("\n");
		assert.ok(missingText.includes("missing: runId, sessionId, operationId, sourceRange.cursor"));
		assertSafeProjectionLines(missingLines, 80);

		const projection = attachment.attach(new MemoryRunFacade([S1_EVENT], [S1_OUTCOME]));
		const lines = renderTuiRunProjection(projection, 80);
		assert.ok(lines.length >= 7);
		const text = lines.join("\n");
		assert.ok(text.includes("run-s1-fixture-0001"));
		assert.ok(text.includes("session-s1-fixture-0001"));
		assert.ok(text.includes("operation-s1-fixture-0001"));
		assert.ok(text.includes("accepted"));
		assert.ok(text.includes("refused"));
		assert.ok(text.includes("degraded"));
		assert.ok(text.includes("cursor-s1-fixture-0001"));
		assert.ok(text.includes("profile_unverified"));
		assert.strictEqual(text.includes("missing:"), false);
		assertSafeProjectionLines(lines, 80);
		const noticeLines = renderTuiNotice(
			{
				level: "warning",
				code: "profile_unverified",
				message: "read-only",
				timestamp: 0,
			},
			80,
		);
		assert.ok(lines.includes(noticeLines[0]));
	});

	it("strips terminal escapes from projection fields and stays within width", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new MemoryRunFacade([
				{
					...S1_EVENT,
					identity: {
						runId: "run-\x1b[2Jsecret",
						sessionId: "session-\x1b]8;;https://evil.example\x07id",
						revision: 0,
					},
				},
			]),
		);
		const lines = renderTuiRunProjection(projection, 40);
		assert.ok(lines.length > 0);
		assertSafeProjectionLines(lines, 40);
		const text = lines.join("");
		assert.strictEqual(text.includes("[2J"), false);
		assert.strictEqual(text.includes("https://evil.example"), false);
		assert.strictEqual(text.includes("\x1b"), false);
	});

	it("returns no lines for non-positive width", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(new MemoryRunFacade([S1_EVENT], [S1_OUTCOME]));
		assert.deepStrictEqual(renderTuiRunProjection(projection, 0), []);
		assert.deepStrictEqual(renderTuiRunProjection(projection, -2), []);
	});

	it("keeps rendering sandbox=refused after a later ready event following profile_unverified", () => {
		const attachment = new TuiRunAttachment();
		attachment.attach(new MemoryRunFacade([S1_EVENT], [S1_OUTCOME]));
		attachment.beginAttach();
		const projection = attachment.apply(
			new MemoryRunFacade([
				boxEvent("3", "box.sandboxes.waitReady", { state: "ready", factsDigest: "sha256:late" }),
			]),
		);
		const lines = renderTuiRunProjection(projection, 80);
		const text = lines.join("\n");
		assert.ok(text.includes("sandbox: refused"));
		assert.strictEqual(text.includes("sandbox: ready"), false);
		assert.ok(text.includes("profile_unverified"));
		assertSafeProjectionLines(lines, 80);
	});

	it("flattens unicode format and bidi controls in projection text", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			new MemoryRunFacade([
				{
					...S1_EVENT,
					identity: {
						runId: "run-\u202Esecret\u202C",
						sessionId: "session-\u2066id\u2069",
						revision: 0,
					},
				},
			]),
		);
		const lines = renderTuiRunProjection(projection, 80);
		const text = lines.join("");
		assert.strictEqual(text.includes("\u202E"), false);
		assert.strictEqual(text.includes("\u202C"), false);
		assert.strictEqual(text.includes("\u2066"), false);
		assert.strictEqual(text.includes("\u2069"), false);
		assert.ok(text.includes("secret"));
		assertSafeProjectionLines(lines, 80);
	});
});
