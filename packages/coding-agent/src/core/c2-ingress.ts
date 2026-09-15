const C2_KINDS = ["user_input", "tool_result", "branch_control"] as const;

export type C2Kind = (typeof C2_KINDS)[number];

export type C2UserSource = {
	kind: "external_user";
	actorRef: string;
};

export type C2ToolSource = {
	kind: "native_tool_execution";
	toolCallRef: string;
};

export type C2ControlSource = {
	kind: "control_intent";
};

export type C2Source = C2UserSource | C2ToolSource | C2ControlSource;

export type C2Provenance =
	| { path: "P1.ingress"; strategyRef: null }
	| { path: "P2.content"; storagePath: "P7.storage.append"; strategyRef: null }
	| { path: "P8.storage.structure"; strategyRef: null };

export type C2IngressRecord = {
	kind: C2Kind;
	actor: string;
	requestId: string;
	sessionId: string;
	branchId: string;
	baseRevision: number;
	source: C2Source;
	cause: string;
	idempotencyKey: string;
	payload: unknown;
	provenance: C2Provenance;
};

export type C2CallOptions = {
	requestId?: string;
	idempotencyKey?: string;
	baseRevision?: number;
	actor?: string;
	branchId?: string;
};

export type C2Accepted = {
	status: "accepted";
	kind: C2Kind;
	replayed: boolean;
	record: C2IngressRecord;
};

export type C2Refused = {
	status: "refused";
	code:
		| "missing_field"
		| "invalid_base_revision"
		| "empty_idempotency_key"
		| "unknown_kind"
		| "idempotency_conflict"
		| "revision_conflict";
	sideEffect: "none";
	retry: "none" | "re-read-and-resubmit" | "inspect-before-retry";
	reconcile: false;
	operation?: C2Kind;
	requestId?: string;
	sessionId?: string;
	branchId?: string;
	field?: string;
};

export type C2Result = C2Accepted | C2Refused;

export type C2RevisionProvider = {
	getCurrentRevision: (identity: { sessionId: string; branchId: string }) => number;
};

/** Stable branchId used when the session tree has no leaf. */
export const C2_EMPTY_LEAF_ID = "leaf:empty";

const REQUIRED_PRESENT_FIELDS = [
	"kind",
	"actor",
	"requestId",
	"sessionId",
	"branchId",
	"source",
	"cause",
	"idempotencyKey",
	"payload",
] as const;

export class C2RefusedError extends Error {
	readonly result: C2Refused;

	constructor(result: C2Refused) {
		super(`C2 refused: ${result.code}`);
		this.name = "C2RefusedError";
		this.result = result;
	}
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
	return Object.hasOwn(value, field) && value[field] !== undefined;
}

function isC2Kind(value: string): value is C2Kind {
	return (C2_KINDS as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function retryFor(code: C2Refused["code"]): C2Refused["retry"] {
	if (code === "revision_conflict") {
		return "re-read-and-resubmit";
	}
	if (code === "idempotency_conflict") {
		return "inspect-before-retry";
	}
	return "none";
}

function refused(
	code: C2Refused["code"],
	options: {
		field?: string;
		operation?: C2Kind;
		requestId?: string;
		sessionId?: string;
		branchId?: string;
	} = {},
): C2Refused {
	const result: C2Refused = {
		status: "refused",
		code,
		sideEffect: "none",
		retry: retryFor(code),
		reconcile: false,
	};
	if (options.field !== undefined) {
		result.field = options.field;
	}
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

function provenanceFor(kind: C2Kind): C2Provenance {
	if (kind === "tool_result") {
		return { path: "P2.content", storagePath: "P7.storage.append", strategyRef: null };
	}
	if (kind === "branch_control") {
		return { path: "P8.storage.structure", strategyRef: null };
	}
	return { path: "P1.ingress", strategyRef: null };
}

function parseSource(kind: C2Kind, value: unknown, actor: string): C2Source | C2Refused {
	if (!isObjectRecord(value) || !isNonEmptyString(value.kind)) {
		return refused("missing_field", { field: "source", operation: kind });
	}
	if (kind === "user_input") {
		if (value.kind !== "external_user") {
			return refused("missing_field", { field: "source", operation: kind });
		}
		const actorRef = isNonEmptyString(value.actorRef) ? value.actorRef : actor;
		return { kind: "external_user", actorRef };
	}
	if (kind === "tool_result") {
		if (value.kind !== "native_tool_execution") {
			return refused("missing_field", { field: "source", operation: kind });
		}
		if (!isNonEmptyString(value.toolCallRef)) {
			return refused("missing_field", { field: "toolCallRef", operation: kind });
		}
		return { kind: "native_tool_execution", toolCallRef: value.toolCallRef };
	}
	if (value.kind !== "control_intent") {
		return refused("missing_field", { field: "source", operation: kind });
	}
	return { kind: "control_intent" };
}

function canonicalize(record: C2IngressRecord): string {
	return JSON.stringify({
		kind: record.kind,
		actor: record.actor,
		sessionId: record.sessionId,
		branchId: record.branchId,
		source: record.source,
		cause: record.cause,
		payload: record.payload,
	});
}

/** Identity-scoped so the same key can be reused on a different branch. */
function idempotencyScope(sessionId: string, branchId: string, idempotencyKey: string): string {
	return `${sessionId}\n${branchId}\n${idempotencyKey}`;
}

export class C2Ingress {
	private readonly getCurrentRevision: C2RevisionProvider["getCurrentRevision"];
	private readonly pending: Map<string, C2IngressRecord>;
	private readonly committed: Map<string, C2IngressRecord>;

	constructor(options: C2RevisionProvider) {
		this.getCurrentRevision = options.getCurrentRevision;
		this.pending = new Map();
		this.committed = new Map();
	}

	/** Find a live admission for replay. Released and refused inputs have no record. */
	getRecord(identity: { sessionId: string; branchId?: string; idempotencyKey: string }): C2IngressRecord | undefined {
		if (identity.branchId !== undefined) {
			const scope = idempotencyScope(identity.sessionId, identity.branchId, identity.idempotencyKey);
			return this.committed.get(scope) ?? this.pending.get(scope);
		}
		for (const records of [this.committed, this.pending]) {
			for (const record of records.values()) {
				if (record.sessionId === identity.sessionId && record.idempotencyKey === identity.idempotencyKey) {
					return record;
				}
			}
		}
		return undefined;
	}

	commit(record: C2IngressRecord): void {
		const scope = idempotencyScope(record.sessionId, record.branchId, record.idempotencyKey);
		const pending = this.pending.get(scope);
		if (pending !== record) {
			return;
		}
		this.pending.delete(scope);
		this.committed.set(scope, record);
	}

	release(record: C2IngressRecord): void {
		const scope = idempotencyScope(record.sessionId, record.branchId, record.idempotencyKey);
		if (this.pending.get(scope) !== record) {
			return;
		}
		this.pending.delete(scope);
	}

	submit(input: unknown): C2Result {
		if (!isObjectRecord(input)) {
			return refused("missing_field", { field: "record" });
		}

		for (const field of REQUIRED_PRESENT_FIELDS) {
			if (!hasOwn(input, field)) {
				return refused("missing_field", { field });
			}
		}

		const kindValue = input.kind;
		if (typeof kindValue !== "string") {
			return refused("missing_field", { field: "kind" });
		}
		if (!isC2Kind(kindValue)) {
			return refused("unknown_kind");
		}

		const identity: { operation: C2Kind; requestId?: string; sessionId?: string; branchId?: string } = {
			operation: kindValue,
		};

		const actor = input.actor;
		if (!isNonEmptyString(actor)) {
			return refused("missing_field", { field: "actor", ...identity });
		}

		const requestId = input.requestId;
		if (!isNonEmptyString(requestId)) {
			return refused("missing_field", { field: "requestId", ...identity });
		}
		identity.requestId = requestId;

		const sessionId = input.sessionId;
		if (!isNonEmptyString(sessionId)) {
			return refused("missing_field", { field: "sessionId", ...identity });
		}
		identity.sessionId = sessionId;

		const branchId = input.branchId;
		if (!isNonEmptyString(branchId)) {
			return refused("missing_field", { field: "branchId", ...identity });
		}
		identity.branchId = branchId;

		const cause = input.cause;
		if (!isNonEmptyString(cause)) {
			return refused("missing_field", { field: "cause", ...identity });
		}

		const idempotencyKey = input.idempotencyKey;
		if (typeof idempotencyKey !== "string") {
			return refused("missing_field", { field: "idempotencyKey", ...identity });
		}
		if (idempotencyKey.trim().length === 0) {
			return refused("empty_idempotency_key", identity);
		}

		if (!hasOwn(input, "baseRevision")) {
			return refused("missing_field", { field: "baseRevision", ...identity });
		}
		const baseRevision = input.baseRevision;
		if (!isNonNegativeInteger(baseRevision)) {
			return refused("invalid_base_revision", identity);
		}

		const source = parseSource(kindValue, input.source, actor);
		if ("status" in source) {
			return {
				...source,
				...("requestId" in identity ? { requestId: identity.requestId } : {}),
				...("sessionId" in identity ? { sessionId: identity.sessionId } : {}),
				...("branchId" in identity ? { branchId: identity.branchId } : {}),
			};
		}

		const record: C2IngressRecord = {
			kind: kindValue,
			actor,
			requestId,
			sessionId,
			branchId,
			baseRevision,
			source,
			cause,
			idempotencyKey,
			payload: input.payload,
			provenance: provenanceFor(kindValue),
		};

		const scope = idempotencyScope(sessionId, branchId, idempotencyKey);
		const existing = this.committed.get(scope);
		if (existing) {
			if (canonicalize(existing) === canonicalize(record)) {
				return {
					status: "accepted",
					kind: existing.kind,
					replayed: true,
					record: existing,
				};
			}
			return refused("idempotency_conflict", identity);
		}

		if (this.pending.has(scope)) {
			return refused("idempotency_conflict", identity);
		}

		if (baseRevision !== this.getCurrentRevision({ sessionId, branchId })) {
			return refused("revision_conflict", identity);
		}

		this.pending.set(scope, record);
		return {
			status: "accepted",
			kind: record.kind,
			replayed: false,
			record,
		};
	}
}
