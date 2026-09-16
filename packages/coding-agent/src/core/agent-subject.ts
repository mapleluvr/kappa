/**
 * S1 Agent Subject facade over an in-process live AgentSession.
 * This is not a spawned RPC/print process and is not G2 completion.
 * Typed envelopes are produced from Session events; C2 remains the ingress for P1/P2/P8.
 */

import { type ImageContent, uuidv7 } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import { C2_EMPTY_LEAF_ID, type C2Refused, C2RefusedError } from "./c2-ingress.ts";

export const AGENT_SUBJECT_SCHEMA_VERSION = "s1-draft-1";

export type AgentSubjectEventType =
	| "agent.accepted"
	| "agent.refused"
	| "agent.unknown"
	| "agent.running"
	| "agent.agent_end"
	| "agent.agent_settled";

export type AgentSubjectCause =
	| { kind: "external_intent"; requestId: string }
	| { kind: "agent_lifecycle"; requestId?: string };

export type AgentSubjectProvenance = {
	owner: "kappa-agent";
	source: "native";
};

export type AgentSubjectIdentity = {
	sessionId: string;
	/** Admission branch of the associated request; pinned across that request's lifecycle events. */
	branchId: string;
	/** Live session tree revision at event time. */
	revision: number;
	requestId?: string;
	runId?: string;
};

export type AgentSubjectEvent = {
	schemaVersion: typeof AGENT_SUBJECT_SCHEMA_VERSION;
	eventId: string;
	cursor: string;
	type: AgentSubjectEventType;
	identity: AgentSubjectIdentity;
	revision: number;
	cause: AgentSubjectCause;
	payload: Record<string, unknown>;
	provenance: AgentSubjectProvenance;
};

export type AgentSubjectOptions = {
	runId?: string;
};

export type AgentSubjectSubmitInput = {
	text: string;
	requestId?: string;
	idempotencyKey?: string;
	actor?: string;
	branchId?: string;
	baseRevision?: number;
	images?: ImageContent[];
};

export type AgentSubjectUnsupported = {
	kind: "unsupported";
	code: "unsupported_operation";
	operation: string;
	sideEffect: "none";
	retry: "none";
	reconcile: false;
};

export type AgentSubjectRefused = {
	kind: "refused";
	code: C2Refused["code"] | "not_started" | "unknown_cursor" | "missing_field" | "not_persisted" | "request_in_flight";
	sideEffect: "none";
	retry: C2Refused["retry"];
	reconcile: false;
	operation?: string;
	requestId?: string;
	sessionId?: string;
	branchId?: string;
	field?: string;
};

export type AgentSubjectUnknown = {
	kind: "unknown";
	code: "c2_result_missing" | "not_persisted" | "settlement_not_observed";
	sideEffect: "unknown";
	retry: "inspect-before-retry";
	reconcile: true;
	operation?: string;
	requestId?: string;
	sessionId?: string;
	branchId?: string;
};

export type AgentSubjectStartResult = {
	kind: "ok";
	identity: AgentSubjectIdentity;
};

export type AgentSubjectSubmitResult =
	| {
			kind: "accepted";
			replayed: boolean;
			requestId: string;
			sessionId: string;
			branchId: string;
			revision: number;
	  }
	| AgentSubjectRefused
	| AgentSubjectUnknown;

export type AgentSubjectObserveResult =
	| {
			kind: "ok";
			events: AgentSubjectEvent[];
			cursor: string | null;
	  }
	| AgentSubjectRefused;

export type AgentSubjectAbortResult = { kind: "ok" } | AgentSubjectRefused;

export type AgentSubjectSettledResult =
	| {
			kind: "ok";
			state: "agent_settled";
			event: AgentSubjectEvent;
	  }
	| AgentSubjectRefused
	| AgentSubjectUnknown;

export type AgentSubjectResult =
	| AgentSubjectStartResult
	| AgentSubjectSubmitResult
	| AgentSubjectObserveResult
	| AgentSubjectAbortResult
	| AgentSubjectSettledResult
	| AgentSubjectUnsupported;

const S1_OPERATIONS = new Set(["start", "submit", "observe", "abort", "settled"]);

function isImageContent(value: unknown): value is ImageContent {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const image = value as Record<string, unknown>;
	return image.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string";
}

function submitImagesFromInvoke(images: unknown): ImageContent[] | undefined | "invalid" {
	if (!Array.isArray(images)) {
		return undefined;
	}
	if (!images.every(isImageContent)) {
		return "invalid";
	}
	return images;
}

function notStarted(operation: string): AgentSubjectRefused {
	return {
		kind: "refused",
		code: "not_started",
		operation,
		sideEffect: "none",
		retry: "none",
		reconcile: false,
	};
}

function unsupported(operation: string): AgentSubjectUnsupported {
	return {
		kind: "unsupported",
		code: "unsupported_operation",
		operation,
		sideEffect: "none",
		retry: "none",
		reconcile: false,
	};
}

function fromC2Refused(result: C2Refused): AgentSubjectRefused {
	const refused: AgentSubjectRefused = {
		kind: "refused",
		code: result.code,
		sideEffect: result.sideEffect,
		retry: result.retry,
		reconcile: result.reconcile,
	};
	if (result.operation !== undefined) {
		refused.operation = result.operation;
	}
	if (result.requestId !== undefined) {
		refused.requestId = result.requestId;
	}
	if (result.sessionId !== undefined) {
		refused.sessionId = result.sessionId;
	}
	if (result.branchId !== undefined) {
		refused.branchId = result.branchId;
	}
	if (result.field !== undefined) {
		refused.field = result.field;
	}
	return refused;
}

function unknownResult(
	code: AgentSubjectUnknown["code"],
	options: {
		operation?: string;
		requestId?: string;
		sessionId?: string;
		branchId?: string;
	} = {},
): AgentSubjectUnknown {
	const result: AgentSubjectUnknown = {
		kind: "unknown",
		code,
		sideEffect: "unknown",
		retry: "inspect-before-retry",
		reconcile: true,
	};
	if (options.operation !== undefined) {
		result.operation = options.operation;
	}
	if (options.requestId !== undefined) {
		result.requestId = options.requestId;
	}
	if (options.sessionId !== undefined) {
		result.sessionId = options.sessionId;
	}
	if (options.branchId !== undefined) {
		result.branchId = options.branchId;
	}
	return result;
}

export class AgentSubject {
	private readonly session: AgentSession;
	private readonly runId: string | undefined;
	private started = false;
	private unsubscribe: (() => void) | undefined;
	private readonly events: AgentSubjectEvent[] = [];
	private currentRequestId: string | undefined;
	private currentBranchId: string | undefined;
	private submitInFlight = false;
	private eventGeneration = 0;
	private listeningGeneration = 0;
	private readonly settlementWaiters = new Set<() => void>();

	constructor(session: AgentSession, options: AgentSubjectOptions = {}) {
		this.session = session;
		this.runId = options.runId;
	}

	start(): AgentSubjectStartResult {
		if (!this.unsubscribe) {
			this.unsubscribe = this.session.subscribe(this.onSessionEvent);
		}
		this.started = true;
		return {
			kind: "ok",
			identity: this.currentIdentity(),
		};
	}

	/** Unsubscribe and drop the current settlement pin. Observed events remain in the buffer for a later start(). */
	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.started = false;
		this.currentRequestId = undefined;
		this.currentBranchId = undefined;
		this.eventGeneration += 1;
		this.notifySettlementWaiters();
	}

	async submit(input: AgentSubjectSubmitInput): Promise<AgentSubjectSubmitResult> {
		if (!this.started) {
			return notStarted("submit");
		}

		const requestId = input.requestId ?? uuidv7();
		const idempotencyKey = input.idempotencyKey ?? requestId;
		if (this.submitInFlight) {
			return this.refuseOverlappingSubmit(requestId);
		}
		this.submitInFlight = true;
		this.listeningGeneration = this.eventGeneration;
		try {
			try {
				await this.session.prompt(input.text, {
					requestId,
					idempotencyKey,
					actor: input.actor,
					branchId: input.branchId,
					baseRevision: input.baseRevision,
					images: input.images,
				});
			} catch (error) {
				if (error instanceof C2RefusedError) {
					return fromC2Refused(error.result);
				}
				return this.unpersistedSubmit(requestId, idempotencyKey);
			}

			const result = this.session.getC2Result(requestId);
			if (result?.status === "accepted") {
				return {
					kind: "accepted",
					replayed: result.replayed,
					requestId: result.record.requestId,
					sessionId: result.record.sessionId,
					branchId: result.record.branchId,
					revision: result.record.baseRevision,
				};
			}
			if (result?.status === "refused") {
				return fromC2Refused(result);
			}
			return unknownResult("c2_result_missing", {
				operation: "submit",
				requestId,
				sessionId: this.session.sessionId,
				branchId: this.currentBranchId ?? this.branchId(),
			});
		} finally {
			this.submitInFlight = false;
			this.notifySettlementWaiters();
		}
	}

	observe(cursor?: string | null): AgentSubjectObserveResult {
		if (!this.started) {
			return notStarted("observe");
		}
		if (cursor === undefined || cursor === null) {
			return {
				kind: "ok",
				events: [...this.events],
				cursor: this.events[this.events.length - 1]?.cursor ?? null,
			};
		}
		const index = this.cursorIndex(cursor);
		if (index === undefined) {
			return {
				kind: "refused",
				code: "unknown_cursor",
				operation: "observe",
				sideEffect: "none",
				retry: "none",
				reconcile: false,
			};
		}
		const events = this.events.slice(index + 1);
		return {
			kind: "ok",
			events,
			cursor: events[events.length - 1]?.cursor ?? cursor,
		};
	}

	async abort(): Promise<AgentSubjectAbortResult> {
		if (!this.started) {
			return notStarted("abort");
		}
		await this.session.abort();
		return { kind: "ok" };
	}

	async settled(): Promise<AgentSubjectSettledResult> {
		if (!this.started) {
			return notStarted("settled");
		}
		const event = await this.waitForAgentSettlement();
		if (!event) {
			return unknownResult("settlement_not_observed", {
				operation: "settled",
				requestId: this.currentRequestId,
				sessionId: this.session.sessionId,
				branchId: this.currentBranchId ?? this.branchId(),
			});
		}
		return {
			kind: "ok",
			state: "agent_settled",
			event,
		};
	}

	async invoke(operation: { type: string; [key: string]: unknown }): Promise<AgentSubjectResult> {
		if (!S1_OPERATIONS.has(operation.type)) {
			return unsupported(operation.type);
		}
		if (operation.type === "start") {
			return this.start();
		}
		if (operation.type === "submit") {
			if (typeof operation.text !== "string") {
				return {
					kind: "refused",
					code: "missing_field",
					operation: "submit",
					field: "text",
					sideEffect: "none",
					retry: "none",
					reconcile: false,
				};
			}
			const images = submitImagesFromInvoke(operation.images);
			if (images === "invalid") {
				return {
					kind: "refused",
					code: "missing_field",
					operation: "submit",
					field: "images",
					sideEffect: "none",
					retry: "none",
					reconcile: false,
				};
			}
			return this.submit({
				text: operation.text,
				requestId: typeof operation.requestId === "string" ? operation.requestId : undefined,
				idempotencyKey: typeof operation.idempotencyKey === "string" ? operation.idempotencyKey : undefined,
				actor: typeof operation.actor === "string" ? operation.actor : undefined,
				branchId: typeof operation.branchId === "string" ? operation.branchId : undefined,
				baseRevision: typeof operation.baseRevision === "number" ? operation.baseRevision : undefined,
				images,
			});
		}
		if (operation.type === "observe") {
			const cursor = operation.cursor;
			if (cursor === undefined || cursor === null || typeof cursor === "string") {
				return this.observe(cursor);
			}
			return {
				kind: "refused",
				code: "unknown_cursor",
				operation: "observe",
				sideEffect: "none",
				retry: "none",
				reconcile: false,
			};
		}
		if (operation.type === "abort") {
			return this.abort();
		}
		return this.settled();
	}

	private onSessionEvent = (event: AgentSessionEvent): void => {
		if (this.listeningGeneration !== this.eventGeneration) {
			return;
		}
		if (event.type === "c2_result") {
			if (event.result.status === "accepted" && event.result.kind === "user_input") {
				const record = event.result.record;
				this.currentRequestId = record.requestId;
				this.currentBranchId = record.branchId;
				this.appendEvent("agent.accepted", {
					requestId: record.requestId,
					branchId: record.branchId,
					cause: { kind: "external_intent", requestId: record.requestId },
					payload: {
						kind: record.kind,
						replayed: event.result.replayed,
						provenance: record.provenance,
					},
				});
				return;
			}
			if (event.result.status === "refused") {
				const requestId = event.result.requestId;
				this.appendEvent("agent.refused", {
					requestId,
					branchId: event.result.branchId,
					cause: requestId !== undefined ? { kind: "external_intent", requestId } : { kind: "agent_lifecycle" },
					payload: {
						code: event.result.code,
						operation: event.result.operation,
					},
				});
			}
			return;
		}
		if (event.type === "agent_start") {
			this.appendEvent("agent.running", {
				requestId: this.currentRequestId,
				branchId: this.currentBranchId,
				cause: this.lifecycleCause(),
				payload: {},
			});
			return;
		}
		if (event.type === "agent_end") {
			this.appendEvent("agent.agent_end", {
				requestId: this.currentRequestId,
				branchId: this.currentBranchId,
				cause: this.lifecycleCause(),
				payload: { willRetry: event.willRetry },
			});
			return;
		}
		if (event.type === "agent_settled") {
			this.appendEvent("agent.agent_settled", {
				requestId: this.currentRequestId,
				branchId: this.currentBranchId,
				cause: this.lifecycleCause(),
				payload: {},
			});
		}
	};

	private appendEvent(
		type: AgentSubjectEventType,
		options: {
			requestId?: string;
			branchId?: string;
			cause: AgentSubjectCause;
			payload: Record<string, unknown>;
		},
	): AgentSubjectEvent {
		const revision = this.revision();
		const identity: AgentSubjectIdentity = {
			sessionId: this.session.sessionId,
			branchId: options.branchId ?? this.branchId(),
			revision,
		};
		if (this.runId !== undefined) {
			identity.runId = this.runId;
		}
		const requestId = options.requestId ?? this.currentRequestId;
		if (requestId !== undefined) {
			identity.requestId = requestId;
		}
		const event: AgentSubjectEvent = {
			schemaVersion: AGENT_SUBJECT_SCHEMA_VERSION,
			eventId: uuidv7(),
			cursor: String(this.events.length),
			type,
			identity,
			revision,
			cause: options.cause,
			payload: options.payload,
			provenance: { owner: "kappa-agent", source: "native" },
		};
		this.events.push(event);
		if (type === "agent.agent_settled") {
			this.notifySettlementWaiters();
		}
		return event;
	}

	private currentIdentity(): AgentSubjectIdentity {
		const identity: AgentSubjectIdentity = {
			sessionId: this.session.sessionId,
			branchId: this.branchId(),
			revision: this.revision(),
		};
		if (this.runId !== undefined) {
			identity.runId = this.runId;
		}
		return identity;
	}

	private lifecycleCause(): AgentSubjectCause {
		if (this.currentRequestId !== undefined) {
			return { kind: "agent_lifecycle", requestId: this.currentRequestId };
		}
		return { kind: "agent_lifecycle" };
	}

	private branchId(): string {
		return this.session.sessionManager.getLeafId() ?? C2_EMPTY_LEAF_ID;
	}

	private revision(): number {
		return this.session.sessionManager.getTreeRevision();
	}

	private cursorIndex(cursor: string): number | undefined {
		if (!/^\d+$/.test(cursor)) {
			return undefined;
		}
		const index = Number(cursor);
		if (this.events[index]?.cursor === cursor) {
			return index;
		}
		return undefined;
	}

	private refuseOverlappingSubmit(requestId: string): AgentSubjectRefused {
		const branchId = this.currentBranchId ?? this.branchId();
		this.appendEvent("agent.refused", {
			requestId,
			branchId,
			cause: { kind: "external_intent", requestId },
			payload: {
				code: "request_in_flight",
				operation: "submit",
			},
		});
		return {
			kind: "refused",
			code: "request_in_flight",
			operation: "submit",
			requestId,
			sessionId: this.session.sessionId,
			branchId,
			sideEffect: "none",
			retry: "re-read-and-resubmit",
			reconcile: false,
		};
	}

	private notifySettlementWaiters(): void {
		const waiters = [...this.settlementWaiters];
		this.settlementWaiters.clear();
		for (const waiter of waiters) {
			waiter();
		}
	}

	private whenSettlementMayHaveChanged(): Promise<void> {
		return new Promise((resolve) => {
			this.settlementWaiters.add(resolve);
		});
	}

	private async waitForAgentSettlement(): Promise<AgentSubjectEvent | undefined> {
		while (this.started) {
			const event = this.currentSettlementEvent();
			if (event) {
				return event;
			}
			if (!this.submitInFlight && !this.session.isStreaming) {
				return undefined;
			}
			const wait = this.whenSettlementMayHaveChanged();
			const again = this.currentSettlementEvent();
			if (again) {
				return again;
			}
			if (!this.submitInFlight && !this.session.isStreaming) {
				return undefined;
			}
			await wait;
		}
		return this.currentSettlementEvent();
	}

	private currentSettlementEvent(): AgentSubjectEvent | undefined {
		const requestId = this.currentRequestId;
		if (requestId === undefined) {
			return undefined;
		}
		for (let index = this.events.length - 1; index >= 0; index--) {
			const event = this.events[index];
			if (event?.type !== "agent.agent_settled") {
				continue;
			}
			if (event.identity.requestId !== requestId) {
				continue;
			}
			if (this.runId !== undefined && event.identity.runId !== this.runId) {
				continue;
			}
			return event;
		}
		return undefined;
	}

	private unpersistedSubmit(requestId: string, idempotencyKey: string): AgentSubjectRefused | AgentSubjectUnknown {
		const branchId = this.currentBranchId ?? this.branchId();
		const live = this.session.getC2Record(idempotencyKey, branchId);
		if (live) {
			this.appendEvent("agent.unknown", {
				requestId,
				branchId,
				cause: { kind: "external_intent", requestId },
				payload: {
					code: "not_persisted",
					operation: "submit",
					sideEffect: "unknown",
					retry: "inspect-before-retry",
				},
			});
			return unknownResult("not_persisted", {
				operation: "submit",
				requestId,
				sessionId: this.session.sessionId,
				branchId,
			});
		}
		this.appendEvent("agent.refused", {
			requestId,
			branchId,
			cause: { kind: "external_intent", requestId },
			payload: {
				code: "not_persisted",
				operation: "submit",
				sideEffect: "none",
				retry: "re-read-and-resubmit",
			},
		});
		return {
			kind: "refused",
			code: "not_persisted",
			operation: "submit",
			requestId,
			sessionId: this.session.sessionId,
			branchId,
			sideEffect: "none",
			retry: "re-read-and-resubmit",
			reconcile: false,
		};
	}
}

export function createAgentSubject(session: AgentSession, options?: AgentSubjectOptions): AgentSubject {
	return new AgentSubject(session, options);
}
