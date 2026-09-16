/**
 * S5 C2 Claim receipt. Independent of C1 process settled and Run settled.
 */

import type { C2Accepted, C2Kind, C2Provenance, C2Result } from "./c2-ingress.ts";

export const C2_CLAIM_SCHEMA_VERSION = "s5-draft-1";
export const KAPPA_SOURCE_PIN = "9767ba275f3e9a5ee0f5c5342249b629ab1b2282";

export type C2ClaimAdmission = {
	kind: C2Kind;
	status: "accepted";
	idempotencyKey: string;
	requestId: string;
	provenance: C2Provenance;
	replayed: boolean;
};

export type C2ClaimRefusal = {
	status: "refused";
	code: string;
	sideEffect: "none";
	requestId?: string;
};

export type C2ClaimReceipt = {
	schemaVersion: typeof C2_CLAIM_SCHEMA_VERSION;
	kind: "c2_claim";
	pin: string;
	sessionId: string;
	branchId: string;
	requestId: string;
	admissions: C2ClaimAdmission[];
	refusals: C2ClaimRefusal[];
	agentSettledObserved: boolean;
	verdict: "pass" | "fail";
	independentOf: {
		c1ProcessSettled: boolean;
		runSettled: boolean;
	};
};

export function sealC2ClaimReceipt(input: {
	pin: string;
	sessionId: string;
	branchId: string;
	requestId: string;
	results: C2Result[];
	agentSettledObserved: boolean;
	c1ProcessSettled?: boolean;
	runSettled?: boolean;
}): C2ClaimReceipt {
	const admissions: C2ClaimAdmission[] = [];
	const refusals: C2ClaimRefusal[] = [];
	for (const result of input.results) {
		if (result.status === "accepted") {
			admissions.push(toAdmission(result));
			continue;
		}
		refusals.push({
			status: "refused",
			code: result.code,
			sideEffect: result.sideEffect,
			requestId: result.requestId,
		});
	}
	const hasP1 = admissions.some((entry) => entry.kind === "user_input");
	const refusalsClean = refusals.every((entry) => entry.sideEffect === "none");
	return {
		schemaVersion: C2_CLAIM_SCHEMA_VERSION,
		kind: "c2_claim",
		pin: input.pin,
		sessionId: input.sessionId,
		branchId: input.branchId,
		requestId: input.requestId,
		admissions,
		refusals,
		agentSettledObserved: input.agentSettledObserved,
		verdict: hasP1 && refusalsClean ? "pass" : "fail",
		independentOf: {
			c1ProcessSettled: input.c1ProcessSettled === true,
			runSettled: input.runSettled === true,
		},
	};
}

function toAdmission(result: C2Accepted): C2ClaimAdmission {
	return {
		kind: result.kind,
		status: "accepted",
		idempotencyKey: result.record.idempotencyKey,
		requestId: result.record.requestId,
		provenance: result.record.provenance,
		replayed: result.replayed,
	};
}
