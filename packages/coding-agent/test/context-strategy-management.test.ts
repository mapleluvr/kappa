import { describe, expect, it } from "vitest";
import {
	bindContextStrategy,
	CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
	ContextStrategyManagement,
	WRITE_HOOK_CONTEXT_ARTIFACTS,
	WRITE_HOOK_REAL_CONTEXT,
} from "../src/core/context-strategy/management.ts";

function management() {
	return new ContextStrategyManagement();
}

describe("Context Strategy management", () => {
	it("configure creates an inactive entry and does not occupy write hooks", () => {
		const mgmt = management();
		const configured = mgmt.configure({
			entryId: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
			implementationRef: "kappa/default-context-strategy",
			reads: ["raw_history", "current_context", "derived_materials"],
			writes: [WRITE_HOOK_REAL_CONTEXT, WRITE_HOOK_CONTEXT_ARTIFACTS],
		});
		expect(configured).toEqual({ ok: true, entryId: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID });

		const snapshot = mgmt.query();
		expect(snapshot.activeEntryIds).toEqual([]);
		expect(snapshot.writeOwners).toEqual({});
		expect(snapshot.entries).toEqual([
			{
				entryId: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
				implementationRef: "kappa/default-context-strategy",
				revision: undefined,
				reads: ["raw_history", "current_context", "derived_materials"],
				writes: [WRITE_HOOK_REAL_CONTEXT, WRITE_HOOK_CONTEXT_ARTIFACTS],
				state: "inactive",
			},
		]);
	});

	it("prevents one extension from taking or releasing another extension's strategy", () => {
		const mgmt = management();
		const owner = bindContextStrategy(mgmt, { extension: "/extensions/owner.ts" });
		const other = bindContextStrategy(mgmt, { extension: "/extensions/other.ts" });

		expect(
			owner.configure({
				entryId: "owner-entry",
				implementationRef: "owner",
				reads: [],
				writes: [WRITE_HOOK_REAL_CONTEXT],
			}),
		).toEqual({ ok: true, entryId: "owner-entry" });
		expect(owner.activate("owner-entry")).toEqual({ ok: true, entryId: "owner-entry" });
		expect(
			other.configure({
				entryId: "other-entry",
				implementationRef: "other",
				reads: [],
				writes: [WRITE_HOOK_REAL_CONTEXT],
			}),
		).toEqual({ ok: true, entryId: "other-entry" });

		expect(other.deactivate("owner-entry")).toEqual({ ok: false, code: "not_owner", entryId: "owner-entry" });
		expect(other.activate("owner-entry")).toEqual({ ok: false, code: "not_owner", entryId: "owner-entry" });
		expect(other.delete("owner-entry")).toEqual({ ok: false, code: "not_owner", entryId: "owner-entry" });
		expect(other.activate("other-entry")).toEqual({
			ok: false,
			code: "hook_occupied",
			entryId: "other-entry",
			hook: WRITE_HOOK_REAL_CONTEXT,
			owner: "owner-entry",
		});
		expect(mgmt.query().writeOwners).toEqual({ [WRITE_HOOK_REAL_CONTEXT]: "owner-entry" });
		expect(mgmt.query().activeEntryIds).toEqual(["owner-entry"]);
	});

	it("prevents a non-owner from reactivating an inactive owned entry", () => {
		const mgmt = management();
		const owner = bindContextStrategy(mgmt, { extension: "/extensions/owner.ts" });
		const other = bindContextStrategy(mgmt, { extension: "/extensions/other.ts" });
		owner.configure({
			entryId: "owned",
			implementationRef: "owner",
			reads: [],
			writes: [WRITE_HOOK_REAL_CONTEXT],
		});
		owner.activate("owned");
		owner.deactivate("owned");

		expect(other.activate("owned")).toEqual({ ok: false, code: "not_owner", entryId: "owned" });
		expect(mgmt.query().writeOwners).toEqual({});
	});

	it("rejects a second configure for the same entryId", () => {
		const mgmt = management();
		mgmt.configure({
			entryId: "dup",
			implementationRef: "a",
			reads: [],
			writes: [],
		});
		expect(
			mgmt.configure({
				entryId: "dup",
				implementationRef: "b",
				reads: [],
				writes: [],
			}),
		).toEqual({ ok: false, code: "already_exists", entryId: "dup" });
	});

	it("lets two read-only entries activate and share the same read sources", () => {
		const mgmt = management();
		mgmt.configure({
			entryId: "reader-a",
			implementationRef: "skills",
			reads: ["raw_history", "derived_materials"],
			writes: [],
		});
		mgmt.configure({
			entryId: "reader-b",
			implementationRef: "memory",
			reads: ["raw_history", "derived_materials"],
			writes: [],
		});
		expect(mgmt.activate("reader-a")).toEqual({ ok: true, entryId: "reader-a" });
		expect(mgmt.activate("reader-b")).toEqual({ ok: true, entryId: "reader-b" });

		const snapshot = mgmt.query();
		expect(snapshot.activeEntryIds).toEqual(["reader-a", "reader-b"]);
		expect(snapshot.writeOwners).toEqual({});
		expect(snapshot.entries.map((entry) => entry.state)).toEqual(["active", "active"]);
	});

	it("activates an entry only when every declared write hook is free", () => {
		const mgmt = management();
		mgmt.configure({
			entryId: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
			implementationRef: "kappa/default-context-strategy",
			reads: ["raw_history"],
			writes: [WRITE_HOOK_REAL_CONTEXT, WRITE_HOOK_CONTEXT_ARTIFACTS],
		});
		expect(mgmt.activate(CONTEXT_STRATEGY_DEFAULT_ENTRY_ID)).toEqual({
			ok: true,
			entryId: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
		});
		expect(mgmt.query().writeOwners).toEqual({
			[WRITE_HOOK_REAL_CONTEXT]: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
			[WRITE_HOOK_CONTEXT_ARTIFACTS]: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
		});
	});

	it("fails activation atomically when any write hook is already owned", () => {
		const mgmt = management();
		mgmt.configure({
			entryId: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
			implementationRef: "kappa/default-context-strategy",
			reads: ["raw_history"],
			writes: [WRITE_HOOK_REAL_CONTEXT],
		});
		mgmt.activate(CONTEXT_STRATEGY_DEFAULT_ENTRY_ID);
		mgmt.configure({
			entryId: "fork",
			implementationRef: "kappa/default-context-strategy#fork",
			reads: ["raw_history"],
			writes: [WRITE_HOOK_REAL_CONTEXT, WRITE_HOOK_CONTEXT_ARTIFACTS],
		});

		expect(mgmt.activate("fork")).toEqual({
			ok: false,
			code: "hook_occupied",
			entryId: "fork",
			hook: WRITE_HOOK_REAL_CONTEXT,
			owner: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
		});
		expect(mgmt.query().writeOwners).toEqual({
			[WRITE_HOOK_REAL_CONTEXT]: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
		});
		expect(mgmt.query().entries.find((entry) => entry.entryId === "fork")?.state).toBe("inactive");
	});

	it("reports the current owner when a second writer contests the same hook", () => {
		const mgmt = management();
		mgmt.configure({
			entryId: "owner",
			implementationRef: "a",
			reads: [],
			writes: [WRITE_HOOK_REAL_CONTEXT],
		});
		mgmt.configure({
			entryId: "challenger",
			implementationRef: "b",
			reads: [],
			writes: [WRITE_HOOK_REAL_CONTEXT],
		});
		mgmt.activate("owner");
		expect(mgmt.activate("challenger")).toEqual({
			ok: false,
			code: "hook_occupied",
			entryId: "challenger",
			hook: WRITE_HOOK_REAL_CONTEXT,
			owner: "owner",
		});
	});

	it("deactivate releases every write hook owned by the entry", () => {
		const mgmt = management();
		mgmt.configure({
			entryId: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
			implementationRef: "kappa/default-context-strategy",
			reads: ["raw_history"],
			writes: [WRITE_HOOK_REAL_CONTEXT, WRITE_HOOK_CONTEXT_ARTIFACTS],
		});
		mgmt.activate(CONTEXT_STRATEGY_DEFAULT_ENTRY_ID);
		expect(mgmt.deactivate(CONTEXT_STRATEGY_DEFAULT_ENTRY_ID)).toEqual({
			ok: true,
			entryId: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
		});
		expect(mgmt.query().activeEntryIds).toEqual([]);
		expect(mgmt.query().writeOwners).toEqual({});
		expect(mgmt.query().entries[0]?.state).toBe("inactive");
	});

	it("refuses to delete an active entry and deletes only the inactive management record", () => {
		const mgmt = management();
		mgmt.configure({
			entryId: "keep",
			implementationRef: "a",
			reads: [],
			writes: [WRITE_HOOK_REAL_CONTEXT],
		});
		mgmt.activate("keep");
		expect(mgmt.delete("keep")).toEqual({
			ok: false,
			code: "still_active",
			entryId: "keep",
		});

		mgmt.deactivate("keep");
		expect(mgmt.delete("keep")).toEqual({ ok: true, entryId: "keep" });
		expect(mgmt.query().entries).toEqual([]);
		expect(mgmt.query().writeOwners).toEqual({});
	});

	it("replaces the default writer by deactivate then activate of a fork", () => {
		const mgmt = management();
		mgmt.configure({
			entryId: CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
			implementationRef: "kappa/default-context-strategy",
			reads: ["raw_history"],
			writes: [WRITE_HOOK_REAL_CONTEXT, WRITE_HOOK_CONTEXT_ARTIFACTS],
		});
		mgmt.configure({
			entryId: "fork",
			implementationRef: "kappa/default-context-strategy#fork",
			reads: ["raw_history"],
			writes: [WRITE_HOOK_REAL_CONTEXT, WRITE_HOOK_CONTEXT_ARTIFACTS],
		});
		mgmt.activate(CONTEXT_STRATEGY_DEFAULT_ENTRY_ID);
		expect(mgmt.activate("fork").ok).toBe(false);

		mgmt.deactivate(CONTEXT_STRATEGY_DEFAULT_ENTRY_ID);
		expect(mgmt.activate("fork")).toEqual({ ok: true, entryId: "fork" });
		expect(mgmt.query().writeOwners).toEqual({
			[WRITE_HOOK_REAL_CONTEXT]: "fork",
			[WRITE_HOOK_CONTEXT_ARTIFACTS]: "fork",
		});
		expect(mgmt.query().activeEntryIds).toEqual(["fork"]);
	});
});
