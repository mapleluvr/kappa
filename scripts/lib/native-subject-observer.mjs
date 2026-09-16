// Observer-side mapping of one serial native RPC/JSON stream. Never writes to the child.
import { randomUUID } from "node:crypto";

const lifecycle = new Map([
	["agent_start", "agent.running"],
	["agent_end", "agent.agent_end"],
	["agent_settled", "agent.agent_settled"],
]);

export class NativeSubjectObserver {
	#runId;
	#sourceId = randomUUID();
	#events = [];
	#identity;
	#sessionId;
	#phase;

	constructor({ runId }) {
		if (typeof runId !== "string" || !runId.trim()) throw new Error("runId is required");
		this.#runId = runId;
	}

	accept(frame) {
		if (!frame || typeof frame.type !== "string" || frame.schemaVersion !== undefined || frame.type.startsWith("agent.")) {
			throw new Error("Expected a native RPC/JSON frame");
		}
		if (frame.type === "session") {
			this.#bindSession(frame.id);
			return;
		}
		if (frame.type === "c2_result") {
			const result = frame.result;
			if (result?.status !== "accepted" || result.kind !== "user_input") return;
			const record = result.record;
			if (!record || ![record.sessionId, record.branchId, record.requestId].every((id) => typeof id === "string" && id.length > 0) ||
				!Number.isSafeInteger(record.baseRevision) || record.baseRevision < 0) {
				throw new Error("Native admission identity is invalid");
			}
			this.#bindSession(record.sessionId);
			if (result.replayed) return; // No new lifecycle is implied by a replay.
			if (this.#identity && this.#phase !== "settled") throw new Error("Overlapping native admissions are unsupported");
			this.#identity = {
				runId: this.#runId, sessionId: record.sessionId, branchId: record.branchId,
				requestId: record.requestId, revision: record.baseRevision,
			};
			this.#phase = "accepted";
			this.#append("agent.accepted", frame);
			return;
		}
		const type = lifecycle.get(frame.type);
		if (!type) return;
		if (!this.#identity) throw new Error("Lifecycle without native admission");
		if (frame.type === "agent_start") {
			if (!["accepted", "end"].includes(this.#phase)) throw new Error("Unexpected native agent_start");
			this.#phase = "running";
		} else if (frame.type === "agent_end") {
			if (this.#phase !== "running") throw new Error("Unexpected native agent_end");
			this.#phase = "end";
		} else {
			if (this.#phase !== "end") throw new Error("Settlement without native agent_end");
			this.#phase = "settled";
		}
		this.#append(type, frame);
	}

	observe(cursor = null) {
		const position = cursor === null ? 0 : Number(cursor);
		if (!Number.isSafeInteger(position) || position < 0 || position > this.#events.length ||
			(cursor !== null && String(position) !== cursor)) {
			return { kind: "refused", code: "unknown_cursor" };
		}
		return { kind: "ok", events: structuredClone(this.#events.slice(position)), cursor: this.#events.at(-1)?.cursor ?? null };
	}

	settled() {
		if (this.#phase !== "settled") return { kind: "unknown", code: "settlement_not_observed" };
		return { kind: "ok", state: "agent_settled", event: structuredClone(this.#events.at(-1)) };
	}

	#bindSession(sessionId) {
		if (typeof sessionId !== "string" || !sessionId) throw new Error("Native session identity is missing");
		if (this.#sessionId && this.#sessionId !== sessionId) throw new Error("Native session identity changed");
		this.#sessionId = sessionId;
	}

	#append(type, frame) {
		const cursor = String(this.#events.length + 1);
		this.#events.push({
			schemaVersion: "s1-draft-1", eventId: `${this.#sourceId}:${cursor}`, cursor, type,
			identity: { ...this.#identity }, revision: this.#identity.revision,
			cause: { kind: type === "agent.accepted" ? "external_intent" : "agent_lifecycle", requestId: this.#identity.requestId },
			// Native lifecycle frames do not carry the later tree revision. Keep the admission revision explicit.
			payload: { native: structuredClone(frame), revisionSource: "c2_admission" },
			provenance: { owner: "kappa-agent", source: "native" },
		});
	}
}
