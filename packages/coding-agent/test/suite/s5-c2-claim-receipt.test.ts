import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { C2_EMPTY_LEAF_ID } from "../../src/core/c2-ingress.ts";
import {
	KAPPA_SOURCE_PIN,
	sealC2ClaimReceipt,
} from "../../src/core/c2-claim-receipt.ts";
import { createAgentSubject } from "../../src/core/agent-subject.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("S5 C2 Claim receipt", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("passes from a live admitted prompt without requiring agent_settled", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);
		const subject = createAgentSubject(harness.session, { runId: "run-s5" });
		subject.start();
		const submitted = await subject.submit({
			text: "hi",
			requestId: "request-s5",
			idempotencyKey: "idem-s5",
		});
		expect(submitted.kind).toBe("accepted");
		const result = harness.session.getC2Result("request-s5");
		expect(result?.status).toBe("accepted");

		const receipt = sealC2ClaimReceipt({
			pin: KAPPA_SOURCE_PIN,
			sessionId: harness.session.sessionId,
			branchId: C2_EMPTY_LEAF_ID,
			requestId: "request-s5",
			results: result ? [result] : [],
			agentSettledObserved: false,
		});

		expect(receipt.verdict).toBe("pass");
		expect(receipt.agentSettledObserved).toBe(false);
		expect(receipt.independentOf).toEqual({
			c1ProcessSettled: false,
			runSettled: false,
		});
		expect(receipt.admissions).toEqual([
			expect.objectContaining({
				kind: "user_input",
				status: "accepted",
				idempotencyKey: "idem-s5",
			}),
		]);
	});

	it("fails when no P1 admission exists", () => {
		const receipt = sealC2ClaimReceipt({
			pin: KAPPA_SOURCE_PIN,
			sessionId: "session-empty",
			branchId: C2_EMPTY_LEAF_ID,
			requestId: "request-empty",
			results: [],
			agentSettledObserved: true,
		});
		expect(receipt.verdict).toBe("fail");
		expect(receipt.agentSettledObserved).toBe(true);
	});
});
