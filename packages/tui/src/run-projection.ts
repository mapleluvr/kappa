import { flattenDisplayText, truncateDisplayLine } from "./display-text.ts";
import { renderTuiNotice } from "./notice.ts";

export type TuiAttachmentState = "detached" | "attaching" | "attached" | "degraded";
export type TuiAgentRunState = "accepted" | "running" | "agent_end" | "agent_settled";
export type TuiSandboxLifecycleState = "provisioning" | "ready" | "failed" | "stopped" | "expired" | "deleted";
export type TuiSandboxProjectionState = TuiSandboxLifecycleState | "refused" | "unknown";

export interface TuiEnvelopeIdentity {
	readonly runId?: string;
	readonly sessionId?: string;
	readonly branchId?: string;
	readonly requestId?: string;
	readonly revision?: number;
	readonly operationId?: string;
	readonly profileId?: string;
}

export interface TuiEventEnvelope {
	readonly schemaVersion: string;
	readonly eventId: string;
	readonly cursor: string;
	readonly type: string;
	readonly identity: TuiEnvelopeIdentity;
	readonly revision?: number;
	readonly cause: {
		readonly kind: string;
		readonly requestId?: string;
		readonly operationId?: string;
	};
	readonly payload: unknown;
	readonly provenance: {
		readonly owner: string;
		readonly source: string;
	};
}

export interface TuiOutcomeEnvelope {
	readonly operationId: string;
	readonly operation: string;
	readonly identity: TuiEnvelopeIdentity;
	readonly kind: "refused" | "failed" | "unknown";
	readonly code: string;
	readonly sideEffects: string;
	readonly reconcile: boolean;
}

export interface TuiRunIdentity {
	readonly runId?: string;
	readonly sessionId?: string;
	readonly operationId?: string;
}

export interface TuiRunProjection {
	readonly view: "run";
	readonly identity: TuiRunIdentity;
	readonly revision: number;
	readonly content: {
		readonly agent: TuiAgentRunState | null;
		readonly sandbox: TuiSandboxProjectionState | null;
		readonly attachment: TuiAttachmentState;
	};
	readonly provenance: {
		readonly source: "typed_facade";
		readonly readOnly: true;
	};
	readonly sourceRange: {
		readonly cursor: string | null;
	};
	readonly missing: readonly string[];
	readonly warning: {
		readonly code: string;
		readonly severity: "warning";
	} | null;
	readonly readOnly: true;
}

export interface TuiRunFacadeError {
	readonly kind: "refused" | "failed" | "unknown" | "unsupported";
	readonly code: string;
	readonly operation?: string;
	readonly sideEffect?: string;
	readonly retry?: string;
	readonly reconcile?: boolean;
}

export interface TuiRunObserveOk {
	readonly kind: "ok";
	readonly events: Iterable<TuiEventEnvelope>;
}

export type TuiRunObserveResult = Iterable<TuiEventEnvelope> | TuiRunObserveOk | TuiRunFacadeError;

export interface TuiRunFacade {
	readonly kind?: "unified";
	readonly sourceId?: string;
	observe(cursor?: string | null): TuiRunObserveResult;
	outcomes?(): Iterable<TuiOutcomeEnvelope> | TuiRunFacadeError;
}

export interface TuiUnifiedEventSource extends TuiRunFacade {
	readonly kind: "unified";
	readonly sourceId: string;
}

export interface TuiRunMutationInspection {
	readonly supported: false;
	readonly readOnly: true;
}

const AGENT_EVENT_STATES: Record<string, TuiAgentRunState> = {
	"agent.accepted": "accepted",
	"agent.running": "running",
	"agent.agent_end": "agent_end",
	"agent.end": "agent_end",
	"agent.agent_settled": "agent_settled",
	"agent.settled": "agent_settled",
};

const LIFECYCLE_OPERATIONS = new Set(["sandboxes.create", "sandboxes.waitReady", "sandboxes.delete"]);

function isTerminalSandboxState(state: TuiSandboxProjectionState | null): boolean {
	return state === "failed" || state === "stopped" || state === "expired" || state === "deleted";
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object";
}

function optionalRecordString(record: unknown, key: string): string | undefined {
	if (!isRecord(record)) {
		return undefined;
	}
	return optionalString(record[key]);
}

function isIterable<T>(value: unknown): value is Iterable<T> {
	return value != null && typeof value === "object" && Symbol.iterator in value;
}

function isObserveOk(value: unknown): value is TuiRunObserveOk {
	return isRecord(value) && value.kind === "ok" && isIterable<TuiEventEnvelope>(value.events);
}

function isOutcomeKind(value: unknown): value is "refused" | "failed" | "unknown" {
	return value === "refused" || value === "failed" || value === "unknown";
}

function isFacadeErrorKind(value: unknown): value is TuiRunFacadeError["kind"] {
	return isOutcomeKind(value) || value === "unsupported";
}

export function isTuiUnifiedEventSource(value: unknown): value is TuiUnifiedEventSource {
	return (
		isRecord(value) &&
		value.kind === "unified" &&
		typeof value.sourceId === "string" &&
		value.sourceId.length > 0 &&
		typeof value.observe === "function"
	);
}

function isTuiRunFacadeError(value: unknown): value is TuiRunFacadeError {
	if (!isRecord(value) || !isFacadeErrorKind(value.kind)) {
		return false;
	}
	if (typeof value.code !== "string" || value.code.length === 0) {
		return false;
	}
	if ("eventId" in value || "events" in value || "operationId" in value) {
		return false;
	}
	return true;
}

function cursorOrder(cursor: string): bigint | null {
	if (/^(0|[1-9][0-9]*)$/.test(cursor)) {
		return BigInt(cursor);
	}
	return null;
}

function sortEvents(events: readonly TuiEventEnvelope[]): TuiEventEnvelope[] {
	return events
		.map((event, index) => ({ event, index }))
		.sort((left, right) => {
			const leftOrder = cursorOrder(left.event.cursor);
			const rightOrder = cursorOrder(right.event.cursor);
			if (leftOrder != null && rightOrder != null && leftOrder !== rightOrder) {
				return leftOrder < rightOrder ? -1 : 1;
			}
			return left.index - right.index;
		})
		.map((item) => item.event);
}

function boxOperation(type: string): string | undefined {
	return type.startsWith("box.") ? type.slice("box.".length) : undefined;
}

function sandboxStateFromPayload(value: string | undefined): TuiSandboxLifecycleState | undefined {
	if (
		value === "provisioning" ||
		value === "ready" ||
		value === "failed" ||
		value === "stopped" ||
		value === "expired" ||
		value === "deleted"
	) {
		return value;
	}
	return undefined;
}

function outcomeStrength(kind: "refused" | "failed" | "unknown", code: string): number {
	if (kind === "refused" && code === "invalid_state") {
		return 1;
	}
	return 2;
}

function freezeProjection(projection: TuiRunProjection): TuiRunProjection {
	Object.freeze(projection.identity);
	Object.freeze(projection.content);
	Object.freeze(projection.provenance);
	Object.freeze(projection.sourceRange);
	Object.freeze(projection.missing);
	if (projection.warning) {
		Object.freeze(projection.warning);
	}
	return Object.freeze(projection);
}

function readEvents(result: TuiRunObserveResult): TuiEventEnvelope[] | TuiRunFacadeError {
	if (isTuiRunFacadeError(result)) {
		return result;
	}
	if (isObserveOk(result)) {
		return [...result.events];
	}
	if (isIterable<TuiEventEnvelope>(result)) {
		return [...result];
	}
	return { kind: "unknown", code: "observe_failed" };
}

function readOutcomes(
	result: Iterable<TuiOutcomeEnvelope> | TuiRunFacadeError,
): TuiOutcomeEnvelope[] | TuiRunFacadeError {
	if (isTuiRunFacadeError(result)) {
		return result;
	}
	if (isIterable(result)) {
		return [...result];
	}
	return { kind: "unknown", code: "observe_failed" };
}

function unsupportedObserve(code: string): TuiRunFacadeError {
	return {
		kind: "unsupported",
		code,
		operation: "observe",
		sideEffect: "none",
		retry: "none",
		reconcile: false,
	};
}

export function declareTuiUnifiedEventSource(source: {
	readonly sourceId: string;
	observe(cursor?: string | null): TuiRunObserveResult;
	outcomes?(): Iterable<TuiOutcomeEnvelope> | TuiRunFacadeError;
}): TuiUnifiedEventSource {
	const outcomes = source.outcomes;
	return {
		kind: "unified",
		sourceId: source.sourceId,
		observe: (cursor?: string | null) => source.observe(cursor),
		...(outcomes ? { outcomes: () => outcomes.call(source) } : {}),
	};
}

export function inspectTuiRunMutation(command: string): TuiRunMutationInspection {
	void command;
	return { supported: false, readOnly: true };
}

export class TuiRunAttachment {
	private attachmentState: TuiAttachmentState;
	private agentState: TuiAgentRunState | null;
	private sandboxState: TuiSandboxProjectionState | null;
	private runId: string | undefined;
	private sessionId: string | undefined;
	private operationId: string | undefined;
	private revision: number;
	private lastCursor: string | null;
	private warning: { readonly code: string; readonly severity: "warning" } | null;
	private factsDigest: string | undefined;
	private degrade: boolean;
	private sandboxOutcomeStrength: number;
	private sandboxReadyBlocked: boolean;
	private sawReadyWithoutFacts: boolean;
	private readonly seenEventIds: Set<string>;
	private readonly seenOperationIds: Set<string>;
	private readonly eventIds: string[];
	private readonly operationIds: string[];
	private sourceId: string | undefined;
	private currentProjection: TuiRunProjection;

	constructor() {
		this.attachmentState = "detached";
		this.agentState = null;
		this.sandboxState = null;
		this.runId = undefined;
		this.sessionId = undefined;
		this.operationId = undefined;
		this.revision = 0;
		this.lastCursor = null;
		this.warning = null;
		this.factsDigest = undefined;
		this.degrade = false;
		this.sandboxOutcomeStrength = 0;
		this.sandboxReadyBlocked = false;
		this.sawReadyWithoutFacts = false;
		this.seenEventIds = new Set();
		this.seenOperationIds = new Set();
		this.eventIds = [];
		this.operationIds = [];
		this.sourceId = undefined;
		this.currentProjection = this.buildProjection();
	}

	get state(): TuiAttachmentState {
		return this.attachmentState;
	}

	get projection(): TuiRunProjection {
		return this.currentProjection;
	}

	get cursor(): string | null {
		return this.lastCursor;
	}

	get appliedEventIds(): readonly string[] {
		return this.eventIds.slice();
	}

	get appliedOperationIds(): readonly string[] {
		return this.operationIds.slice();
	}

	beginAttach(): TuiRunProjection {
		if (this.attachmentState === "attaching") {
			throw new Error("cannot begin attach while already attaching");
		}
		this.attachmentState = "attaching";
		this.currentProjection = this.buildProjection();
		return this.currentProjection;
	}

	apply(facade: TuiRunFacade, cursor?: string | null): TuiRunProjection {
		if (this.attachmentState !== "attaching") {
			throw new Error("cannot apply unless attaching");
		}
		try {
			if (!isTuiUnifiedEventSource(facade)) {
				this.noteFacadeError(unsupportedObserve("unsupported"));
			} else if (this.sourceId !== undefined && facade.sourceId !== this.sourceId) {
				this.noteFacadeError(unsupportedObserve("independent_cursor_space"));
			} else {
				this.sourceId = facade.sourceId;
				const observeCursor = cursor === undefined ? this.lastCursor : cursor;
				const observed = readEvents(facade.observe(observeCursor));
				if (isTuiRunFacadeError(observed)) {
					this.noteFacadeError(observed);
				} else {
					for (const event of sortEvents(observed)) {
						this.applyEvent(event);
					}
				}
				if (facade.outcomes) {
					const outcomes = readOutcomes(facade.outcomes());
					if (isTuiRunFacadeError(outcomes)) {
						this.noteFacadeError(outcomes);
					} else {
						for (const outcome of outcomes) {
							this.applyOutcome(outcome);
						}
					}
				}
			}
		} catch {
			this.degrade = true;
			if (!this.warning) {
				this.warning = { code: "observe_failed", severity: "warning" };
			}
		}
		this.attachmentState = this.degrade ? "degraded" : "attached";
		this.currentProjection = this.buildProjection();
		return this.currentProjection;
	}

	attach(facade: TuiRunFacade, cursor?: string | null): TuiRunProjection {
		this.beginAttach();
		return this.apply(facade, cursor === undefined ? null : cursor);
	}

	reattach(facade: TuiRunFacade): TuiRunProjection {
		this.beginAttach();
		return this.apply(facade, this.lastCursor);
	}

	detach(): TuiRunProjection {
		this.resetRunState();
		this.currentProjection = this.buildProjection();
		return this.currentProjection;
	}

	private resetRunState(): void {
		this.attachmentState = "detached";
		this.agentState = null;
		this.sandboxState = null;
		this.runId = undefined;
		this.sessionId = undefined;
		this.operationId = undefined;
		this.revision = 0;
		this.lastCursor = null;
		this.warning = null;
		this.factsDigest = undefined;
		this.degrade = false;
		this.sandboxOutcomeStrength = 0;
		this.sandboxReadyBlocked = false;
		this.sawReadyWithoutFacts = false;
		this.seenEventIds.clear();
		this.seenOperationIds.clear();
		this.eventIds.length = 0;
		this.operationIds.length = 0;
		this.sourceId = undefined;
	}

	private noteFacadeError(error: TuiRunFacadeError): void {
		this.degrade = true;
		if (!this.warning) {
			this.warning = { code: error.code, severity: "warning" };
		}
	}

	private applyEvent(event: TuiEventEnvelope): void {
		if (this.seenEventIds.has(event.eventId)) {
			return;
		}
		this.seenEventIds.add(event.eventId);
		if (!this.bindIdentity(event.identity)) {
			return;
		}
		this.eventIds.push(event.eventId);
		if (!this.acceptCursor(event.cursor)) {
			return;
		}
		this.recordOperationId(optionalString(event.identity.operationId));
		if (this.operationId === undefined) {
			this.setProjectedOperationId(optionalString(event.identity.operationId));
		}
		this.advanceRevision(event.revision);
		this.advanceRevision(event.identity.revision);
		const agentState = AGENT_EVENT_STATES[event.type];
		if (agentState) {
			this.agentState = agentState;
		}
		if (event.type === "agent.refused" || event.type === "agent.unknown") {
			this.degrade = true;
			const code = optionalRecordString(event.payload, "code") ?? event.type;
			if (!this.warning) {
				this.warning = { code, severity: "warning" };
			}
		}
		if (event.type === "compaction.warning") {
			if (!this.warning) {
				this.warning = {
					code: optionalRecordString(event.payload, "code") ?? "compaction.warning",
					severity: "warning",
				};
			}
			return;
		}
		this.applyBoxEvent(event);
	}

	private applyBoxEvent(event: TuiEventEnvelope): void {
		const operation = boxOperation(event.type);
		if (operation === undefined) {
			return;
		}
		const payload = event.payload;
		const incomingOp = optionalString(event.identity.operationId);
		if (isRecord(payload) && isOutcomeKind(payload.kind) && typeof payload.code === "string") {
			this.applyLifecycleOutcome(operation, event.identity, payload.kind, payload.code, incomingOp);
			return;
		}
		if (!LIFECYCLE_OPERATIONS.has(operation) || !isRecord(payload)) {
			return;
		}
		const state = sandboxStateFromPayload(optionalString(payload.state));
		if (state === "ready") {
			this.considerReady(operation, optionalRecordString(payload, "factsDigest"), incomingOp);
			return;
		}
		if (state && !this.sandboxReadyBlocked) {
			this.sandboxState = state;
			this.setProjectedOperationId(incomingOp);
			if (isTerminalSandboxState(state)) {
				this.sandboxReadyBlocked = true;
			}
		}
	}

	private considerReady(operation: string, factsDigest: string | undefined, operationId?: string): void {
		if (operation !== "sandboxes.waitReady") {
			return;
		}
		if (!factsDigest) {
			this.sawReadyWithoutFacts = true;
			if (this.operationId === undefined) {
				this.setProjectedOperationId(operationId);
			}
			return;
		}
		if (this.sandboxReadyBlocked) {
			return;
		}
		this.factsDigest = factsDigest;
		this.sandboxState = "ready";
		this.sawReadyWithoutFacts = false;
		this.setProjectedOperationId(operationId);
	}

	private applyOutcome(outcome: TuiOutcomeEnvelope): void {
		if (!this.bindIdentity(outcome.identity)) {
			return;
		}
		this.recordOperationId(outcome.operationId);
		if (this.operationId === undefined) {
			this.setProjectedOperationId(outcome.operationId);
		}
		this.applyLifecycleOutcome(outcome.operation, outcome.identity, outcome.kind, outcome.code, outcome.operationId);
	}

	private applyLifecycleOutcome(
		operation: string,
		identity: TuiEnvelopeIdentity,
		kind: "refused" | "failed" | "unknown",
		code: string,
		operationId?: string,
	): void {
		if (!LIFECYCLE_OPERATIONS.has(operation)) {
			return;
		}
		if (!this.bindIdentity(identity)) {
			return;
		}
		const incomingOp = optionalString(operationId) ?? optionalString(identity.operationId);
		this.recordOperationId(incomingOp);
		if (isTerminalSandboxState(this.sandboxState)) {
			return;
		}
		const strength = outcomeStrength(kind, code);
		if (strength <= this.sandboxOutcomeStrength) {
			return;
		}
		this.sandboxOutcomeStrength = strength;
		if (kind === "unknown") {
			this.sandboxState = "unknown";
		} else if (kind === "failed") {
			this.sandboxState = "failed";
		} else {
			this.sandboxState = "refused";
		}
		this.warning = { code, severity: "warning" };
		this.degrade = true;
		this.sandboxReadyBlocked = true;
		this.setProjectedOperationId(incomingOp);
	}

	private recordOperationId(operationId: string | undefined): void {
		if (!operationId || this.seenOperationIds.has(operationId)) {
			return;
		}
		this.seenOperationIds.add(operationId);
		this.operationIds.push(operationId);
	}

	private setProjectedOperationId(operationId: string | undefined): void {
		if (operationId) {
			this.operationId = operationId;
		}
	}

	private bindIdentity(identity: TuiEnvelopeIdentity): boolean {
		const incomingRun = optionalString(identity.runId);
		const incomingSession = optionalString(identity.sessionId);
		const mismatch =
			(incomingRun !== undefined && this.runId !== undefined && incomingRun !== this.runId) ||
			(incomingSession !== undefined && this.sessionId !== undefined && incomingSession !== this.sessionId);
		if (mismatch) {
			this.degrade = true;
			if (!this.warning) {
				this.warning = { code: "identity_mismatch", severity: "warning" };
			}
			return false;
		}
		if (incomingRun !== undefined) {
			this.runId = incomingRun;
		}
		if (incomingSession !== undefined) {
			this.sessionId = incomingSession;
		}
		return true;
	}

	private acceptCursor(cursor: string): boolean {
		if (!optionalString(cursor)) {
			return true;
		}
		if (this.lastCursor == null) {
			this.lastCursor = cursor;
			return true;
		}
		if (cursor === this.lastCursor) {
			return true;
		}
		const nextOrder = cursorOrder(cursor);
		const lastOrder = cursorOrder(this.lastCursor);
		if (nextOrder != null && lastOrder != null) {
			if (nextOrder < lastOrder) {
				return false;
			}
			this.lastCursor = cursor;
			return true;
		}
		this.lastCursor = cursor;
		return true;
	}

	private advanceRevision(revision: number | undefined): void {
		if (typeof revision === "number" && Number.isFinite(revision) && revision >= this.revision) {
			this.revision = revision;
		}
	}

	private buildProjection(): TuiRunProjection {
		const identity: { runId?: string; sessionId?: string; operationId?: string } = {};
		if (this.runId) {
			identity.runId = this.runId;
		}
		if (this.sessionId) {
			identity.sessionId = this.sessionId;
		}
		if (this.operationId) {
			identity.operationId = this.operationId;
		}
		const missing: string[] = [];
		if (!this.runId) {
			missing.push("runId");
		}
		if (!this.sessionId) {
			missing.push("sessionId");
		}
		if (!this.operationId) {
			missing.push("operationId");
		}
		if (!this.lastCursor) {
			missing.push("sourceRange.cursor");
		}
		if (this.sawReadyWithoutFacts && !this.factsDigest) {
			missing.push("factsDigest");
		}
		return freezeProjection({
			view: "run",
			identity,
			revision: this.revision,
			content: {
				agent: this.agentState,
				sandbox: this.sandboxState,
				attachment: this.attachmentState,
			},
			provenance: { source: "typed_facade", readOnly: true },
			sourceRange: { cursor: this.lastCursor },
			missing,
			warning: this.warning,
			readOnly: true,
		});
	}
}

export function renderTuiRunProjection(projection: TuiRunProjection, width: number): string[] {
	const maxWidth = Math.trunc(width);
	if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
		return [];
	}

	const missing = projection.missing.length > 0 ? projection.missing.join(", ") : "";
	const fields = [
		`run: ${projection.identity.runId ?? "missing"}`,
		`session: ${projection.identity.sessionId ?? "missing"}`,
		`operation: ${projection.identity.operationId ?? "missing"}`,
		`agent: ${projection.content.agent ?? "missing"}`,
		`sandbox: ${projection.content.sandbox ?? "missing"}`,
		`attachment: ${projection.content.attachment}`,
		`cursor: ${projection.sourceRange.cursor ?? "missing"}`,
	];
	if (projection.warning) {
		fields.push(`warning: ${projection.warning.code}`);
	}
	if (missing) {
		fields.push(`missing: ${missing}`);
	}

	const lines = fields.map((field) => truncateDisplayLine(flattenDisplayText(field), maxWidth));
	if (projection.warning) {
		lines.push(
			...renderTuiNotice(
				{
					level: "warning",
					code: projection.warning.code,
					message: "read-only",
					timestamp: 0,
				},
				maxWidth,
			),
		);
	}
	return lines;
}
