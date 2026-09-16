import assert from "node:assert";
import { describe, it } from "node:test";
import {
	declareTuiUnifiedEventSource,
	inspectTuiRunMutation,
	isTuiUnifiedEventSource,
	renderTuiRunProjection,
	type TuiEventEnvelope,
	type TuiOutcomeEnvelope,
	TuiRunAttachment,
	type TuiRunFacade,
	type TuiRunFacadeError,
	type TuiRunProjection,
	type TuiUnifiedEventSource,
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

class MemoryRunFacade implements TuiRunFacade {
	private readonly events: readonly TuiEventEnvelope[];
	private readonly outcomeList: readonly TuiOutcomeEnvelope[];
	private readonly ignoreCursor: boolean;
	readonly observedCursors: Array<string | null | undefined> = [];

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
		this.observedCursors.push(cursor);
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

function unified(facade: MemoryRunFacade, sourceId = "unified-run-source"): TuiUnifiedEventSource {
	return declareTuiUnifiedEventSource({
		sourceId,
		observe: (cursor) => facade.observe(cursor),
		outcomes: () => facade.outcomes(),
	});
}

function assertReadOnlyRunProjection(projection: TuiRunProjection): void {
	assert.strictEqual(projection.view, "run");
	assert.strictEqual(projection.readOnly, true);
	assert.strictEqual(projection.provenance.source, "typed_facade");
	assert.strictEqual(projection.provenance.readOnly, true);
}

function assertSafeProjectionLines(lines: string[], width: number): void {
	for (const line of lines) {
		assert.strictEqual(/[\u0000-\u001F\u007F-\u009F]/.test(line), false);
		assert.strictEqual(line.includes("\n"), false);
		assert.strictEqual(line.includes("\r"), false);
		assert.strictEqual(visibleWidth(line), width);
	}
}

describe("declareTuiUnifiedEventSource", () => {
	it("is the one declared unified typed source accepted by TUI attach", () => {
		const facade = new MemoryRunFacade([S1_EVENT]);
		const source = unified(facade);
		assert.strictEqual(source.kind, "unified");
		assert.strictEqual(source.sourceId, "unified-run-source");
		assert.strictEqual(isTuiUnifiedEventSource(source), true);
		assert.strictEqual(isTuiUnifiedEventSource(facade), false);
		assert.strictEqual(
			isTuiUnifiedEventSource({
				kind: "unified",
				sourceId: "",
				observe() {
					return [];
				},
			}),
			false,
		);
	});
});

describe("TuiRunAttachment unified source", () => {
	it("returns unsupported when attach is not given a declared unified source", () => {
		const attachment = new TuiRunAttachment();
		const undeclared: TuiRunFacade = new MemoryRunFacade([
			S1_EVENT,
			boxEvent("1", "box.sandboxes.waitReady", { state: "ready", factsDigest: "sha256:guessed" }),
		]);
		const projection = attachment.attach(undeclared);
		assertReadOnlyRunProjection(projection);
		assert.strictEqual(attachment.state, "degraded");
		assert.strictEqual(projection.content.attachment, "degraded");
		assert.strictEqual(projection.content.agent, null);
		assert.strictEqual(projection.content.sandbox, null);
		assert.deepStrictEqual(projection.warning, { code: "unsupported", severity: "warning" });
		assert.deepStrictEqual(attachment.appliedEventIds, []);
		assert.strictEqual(attachment.cursor, null);
		assert.notEqual(projection.content.sandbox, "ready");
		assert.deepStrictEqual(inspectTuiRunMutation("observe"), { supported: false, readOnly: true });
	});

	it("does not observe an undeclared source while attaching", () => {
		const attachment = new TuiRunAttachment();
		const undeclared = new MemoryRunFacade([S1_EVENT]);
		attachment.attach(undeclared);
		assert.deepStrictEqual(undeclared.observedCursors, []);
	});

	it("rejects independent Agent and Box cursor spaces instead of merging them", () => {
		const attachment = new TuiRunAttachment();
		const agentSource = unified(
			new MemoryRunFacade([
				eventAt("1", "agent.accepted", {
					revision: 1,
					identity: {
						runId: "run-s1-fixture-0001",
						sessionId: "session-s1-fixture-0001",
						revision: 1,
					},
				}),
			]),
			"agent-cursor-space",
		);
		const first = attachment.attach(agentSource);
		assert.strictEqual(first.content.agent, "accepted");
		assert.strictEqual(first.sourceRange.cursor, "1");
		assert.strictEqual(attachment.state, "attached");

		const boxSource = unified(
			new MemoryRunFacade([
				boxEvent(
					"1",
					"box.sandboxes.waitReady",
					{ state: "ready", factsDigest: "sha256:independent" },
					{
						identity: {
							runId: "run-s1-fixture-0001",
							sessionId: "session-s1-fixture-0001",
							operationId: "operation-wait-0002",
							revision: 1,
						},
					},
				),
			]),
			"box-cursor-space",
		);
		attachment.beginAttach();
		const merged = attachment.apply(boxSource);
		assert.strictEqual(attachment.state, "degraded");
		assert.deepStrictEqual(merged.warning, { code: "independent_cursor_space", severity: "warning" });
		assert.strictEqual(merged.content.agent, "accepted");
		assert.notEqual(merged.content.sandbox, "ready");
		assert.strictEqual(merged.content.sandbox, null);
		assert.strictEqual(merged.sourceRange.cursor, "1");
		assert.strictEqual(merged.identity.runId, "run-s1-fixture-0001");
		assert.deepStrictEqual(attachment.appliedEventIds, ["event-1"]);
		assert.ok(!("factsDigest" in merged.identity));
		assert.deepStrictEqual(inspectTuiRunMutation("sandboxes.waitReady"), { supported: false, readOnly: true });
	});

	it("does not observe a second independent cursor space after the first source is bound", () => {
		const attachment = new TuiRunAttachment();
		attachment.attach(unified(new MemoryRunFacade([eventAt("1", "agent.accepted")]), "agent-cursor-space"));
		const boxFacade = new MemoryRunFacade([
			boxEvent("1", "box.sandboxes.waitReady", { state: "ready", factsDigest: "sha256:independent" }),
		]);
		attachment.beginAttach();
		attachment.apply(unified(boxFacade, "box-cursor-space"));
		assert.deepStrictEqual(boxFacade.observedCursors, []);
		assert.notEqual(attachment.projection.content.sandbox, "ready");
	});

	it("reattaches an observer restart from cursor and skips already applied eventIds", () => {
		const firstFacade = new MemoryRunFacade([eventAt("1", "agent.accepted"), eventAt("2", "agent.running")]);
		const attachment = new TuiRunAttachment();
		const first = attachment.attach(unified(firstFacade));
		assert.strictEqual(first.content.agent, "running");
		assert.strictEqual(first.sourceRange.cursor, "2");
		assert.deepStrictEqual(attachment.appliedEventIds, ["event-1", "event-2"]);

		const restartedFacade = new MemoryRunFacade(
			[
				eventAt("1", "agent.accepted"),
				eventAt("2", "agent.running"),
				eventAt("3", "agent.agent_end"),
				eventAt("4", "agent.agent_settled"),
			],
			[],
			true,
		);
		const restarted = attachment.reattach(unified(restartedFacade));
		assert.strictEqual(restarted.content.agent, "agent_settled");
		assert.strictEqual(restarted.sourceRange.cursor, "4");
		assert.strictEqual(restarted.content.attachment, "attached");
		assert.deepStrictEqual(attachment.appliedEventIds, ["event-1", "event-2", "event-3", "event-4"]);
		assert.deepStrictEqual(restartedFacade.observedCursors, ["2"]);
		assert.strictEqual(restarted.revision, first.revision);
	});

	it("keeps S1 terminal and outcome latch across observer restart on the same unified source", () => {
		const firstFacade = new MemoryRunFacade([S1_EVENT], [S1_OUTCOME]);
		const attachment = new TuiRunAttachment();
		attachment.attach(unified(firstFacade));
		assert.strictEqual(attachment.projection.content.sandbox, "refused");

		const replayReady = new MemoryRunFacade(
			[
				S1_EVENT,
				boxEvent("cursor-ready-3", "box.sandboxes.waitReady", {
					state: "ready",
					factsDigest: "sha256:replayed",
				}),
			],
			[S1_OUTCOME],
			true,
		);
		const restarted = attachment.reattach(unified(replayReady));
		assert.strictEqual(restarted.content.agent, "accepted");
		assert.strictEqual(restarted.content.sandbox, "refused");
		assert.notEqual(restarted.content.sandbox, "ready");
		assert.deepStrictEqual(restarted.warning, { code: "profile_unverified", severity: "warning" });
		assert.strictEqual(attachment.state, "degraded");
		assert.deepStrictEqual(restarted.identity, {
			runId: "run-s1-fixture-0001",
			sessionId: "session-s1-fixture-0001",
			operationId: "operation-s1-fixture-0001",
		});
		assert.strictEqual(restarted.sourceRange.cursor, "cursor-ready-3");
		assert.notEqual(restarted.sourceRange.cursor, String(restarted.revision));
	});

	it("projects compaction.warning as presentation-only without mutating run state", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(
			unified(
				new MemoryRunFacade([
					eventAt("1", "agent.accepted", {
						revision: 1,
						identity: {
							runId: "run-s1-fixture-0001",
							sessionId: "session-s1-fixture-0001",
							revision: 1,
						},
					}),
					{
						schemaVersion: "s0-draft-1",
						eventId: "event-compaction-warning-0001",
						cursor: "2",
						type: "compaction.warning",
						revision: 1,
						identity: {
							runId: "run-s1-fixture-0001",
							sessionId: "session-s1-fixture-0001",
							branchId: "branch-s1-empty-leaf",
							revision: 1,
						},
						cause: { kind: "compaction", operationId: "compaction-fixture-0001" },
						payload: {
							status: "failed",
							messageKey: "context.compaction.failed",
							lastValidProjectionRevision: 1,
							currentProjectionUsable: true,
						},
						provenance: { owner: "kappa-agent", source: "native" },
					},
				]),
			),
		);
		assertReadOnlyRunProjection(projection);
		assert.strictEqual(projection.content.agent, "accepted");
		assert.strictEqual(projection.content.sandbox, null);
		assert.strictEqual(projection.content.attachment, "attached");
		assert.strictEqual(attachment.state, "attached");
		assert.deepStrictEqual(projection.warning, { code: "compaction.warning", severity: "warning" });
		assert.strictEqual(projection.sourceRange.cursor, "2");
		assert.strictEqual(projection.revision, 1);
		assert.deepStrictEqual(attachment.appliedEventIds, ["event-1", "event-compaction-warning-0001"]);
		assert.strictEqual("stop" in attachment, false);
		assert.strictEqual("delete" in attachment, false);
		assert.strictEqual("settle" in attachment, false);
		assert.strictEqual("compact" in attachment, false);
		for (const command of ["stop", "delete", "settle", "abort", "compact", "submit"]) {
			assert.deepStrictEqual(inspectTuiRunMutation(command), { supported: false, readOnly: true });
		}
		const lines = renderTuiRunProjection(projection, 80);
		const text = lines.join("\n");
		assert.ok(text.includes("agent: accepted"));
		assert.ok(text.includes("attachment: attached"));
		assert.ok(text.includes("compaction.warning"));
		assert.ok(text.includes("read-only"));
		assert.strictEqual(text.includes("sandbox: ready"), false);
		assertSafeProjectionLines(lines, 80);
	});

	it("does not let compaction.warning unlatch a profile_unverified sandbox or invent mutation", () => {
		const attachment = new TuiRunAttachment();
		attachment.attach(unified(new MemoryRunFacade([S1_EVENT], [S1_OUTCOME])));
		attachment.beginAttach();
		const projection = attachment.apply(
			unified(
				new MemoryRunFacade([
					{
						schemaVersion: "s0-draft-1",
						eventId: "event-compaction-warning-0002",
						cursor: "cursor-compaction-2",
						type: "compaction.warning",
						identity: {
							runId: "run-s1-fixture-0001",
							sessionId: "session-s1-fixture-0001",
							revision: 0,
						},
						cause: { kind: "compaction" },
						payload: { status: "failed" },
						provenance: { owner: "kappa-agent", source: "native" },
					},
				]),
			),
		);
		assert.strictEqual(projection.content.sandbox, "refused");
		assert.notEqual(projection.content.sandbox, "ready");
		assert.strictEqual(projection.content.agent, "accepted");
		assert.deepStrictEqual(projection.warning, { code: "profile_unverified", severity: "warning" });
		assert.strictEqual(attachment.state, "degraded");
		assert.deepStrictEqual(inspectTuiRunMutation("compact"), { supported: false, readOnly: true });
	});

	it("projects the S1 unverified-profile refusal through one unified source", () => {
		const attachment = new TuiRunAttachment();
		const projection = attachment.attach(unified(new MemoryRunFacade([S1_EVENT], [S1_OUTCOME])));
		assert.strictEqual(attachment.state, "degraded");
		assert.deepStrictEqual(projection.identity, {
			runId: "run-s1-fixture-0001",
			sessionId: "session-s1-fixture-0001",
			operationId: "operation-s1-fixture-0001",
		});
		assert.deepStrictEqual(projection.content, {
			agent: "accepted",
			sandbox: "refused",
			attachment: "degraded",
		});
		assert.deepStrictEqual(projection.warning, { code: "profile_unverified", severity: "warning" });
		assert.strictEqual(projection.readOnly, true);
		assert.notEqual(projection.content.sandbox, "failed");
		assert.notEqual(projection.content.sandbox, "ready");
		assert.deepStrictEqual(attachment.appliedEventIds, [S1_EVENT.eventId]);
	});

	it("treats an observe unsupported error as a typed facade error", () => {
		const attachment = new TuiRunAttachment();
		const error: TuiRunFacadeError = {
			kind: "unsupported",
			code: "independent_cursor_space",
			operation: "observe",
			sideEffect: "none",
			retry: "none",
			reconcile: false,
		};
		const projection = attachment.attach(
			declareTuiUnifiedEventSource({
				sourceId: "unified-run-source",
				observe() {
					return error;
				},
			}),
		);
		assert.strictEqual(attachment.state, "degraded");
		assert.deepStrictEqual(projection.warning, { code: "independent_cursor_space", severity: "warning" });
		assert.strictEqual(projection.content.agent, null);
		assert.deepStrictEqual(attachment.appliedEventIds, []);
	});
});
