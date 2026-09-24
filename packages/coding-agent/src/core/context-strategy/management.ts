/**
 * Context Strategy management plane: entry state and WriteHook occupancy.
 *
 * This kernel does not run compaction, generate artifacts, or write session JSONL.
 * Occupancy is the exclusive right to a write hook, not the write itself.
 */

export const CONTEXT_STRATEGY_DEFAULT_ENTRY_ID = "default-context-strategy";
export const WRITE_HOOK_REAL_CONTEXT = "real_context.write";
export const WRITE_HOOK_CONTEXT_ARTIFACTS = "context_artifacts.write";

export type StrategyEntryState = "inactive" | "active";

export interface ConfigureStrategyRequest {
	entryId: string;
	implementationRef: string;
	revision?: string;
	reads: readonly string[];
	writes: readonly string[];
}

export interface StrategyEntryRecord {
	entryId: string;
	implementationRef: string;
	revision: string | undefined;
	reads: readonly string[];
	writes: readonly string[];
	state: StrategyEntryState;
}

export interface StrategyQuerySnapshot {
	entries: StrategyEntryRecord[];
	activeEntryIds: string[];
	writeOwners: Record<string, string>;
}

export type ConfigureStrategyResult =
	| { ok: true; entryId: string }
	| { ok: false; code: "already_exists"; entryId: string };

export type ActivateStrategyResult =
	| { ok: true; entryId: string }
	| { ok: false; code: "not_found" | "already_active" | "not_owner"; entryId: string }
	| { ok: false; code: "hook_occupied"; entryId: string; hook: string; owner: string };

export type DeactivateStrategyResult =
	| { ok: true; entryId: string }
	| { ok: false; code: "not_found" | "not_active" | "not_owner"; entryId: string };

export type DeleteStrategyResult =
	| { ok: true; entryId: string }
	| { ok: false; code: "not_found" | "still_active" | "not_owner"; entryId: string };

export type CutCaller = { extension: string };

export type CutDecision = { accept: true } | { accept: false; reason?: string };

export type CutPolicy = (cut: unknown, caller: CutCaller) => CutDecision;

export type SetCutPolicyResult = { ok: true } | { ok: false; code: "not_hook_owner" };

export type AuthorizeCutResult =
	| { ok: true }
	| { ok: false; code: "hook_not_owned" | "not_hook_owner" }
	| { ok: false; code: "cut_rejected"; reason?: string };

interface StoredEntry {
	entryId: string;
	implementationRef: string;
	revision: string | undefined;
	reads: string[];
	writes: string[];
	state: StrategyEntryState;
}

export class ContextStrategyManagement {
	private readonly entries = new Map<string, StoredEntry>();
	private readonly entryOwners = new Map<string, string>();
	private readonly owners = new Map<string, string>();
	private readonly activators = new Map<string, string>();
	private cutPolicy: CutPolicy | undefined;

	configure(request: ConfigureStrategyRequest, caller?: CutCaller): ConfigureStrategyResult {
		const entryId = request.entryId;
		if (this.entries.has(entryId)) {
			return { ok: false, code: "already_exists", entryId };
		}
		this.entries.set(entryId, {
			entryId,
			implementationRef: request.implementationRef,
			revision: request.revision,
			reads: [...request.reads],
			writes: [...request.writes],
			state: "inactive",
		});
		if (caller) {
			this.entryOwners.set(entryId, caller.extension);
		}
		return { ok: true, entryId };
	}

	activate(entryId: string, options?: { extension?: string }): ActivateStrategyResult {
		const entry = this.entries.get(entryId);
		if (!entry) {
			return { ok: false, code: "not_found", entryId };
		}
		if (!this.isEntryOwner(entryId, options?.extension)) {
			return { ok: false, code: "not_owner", entryId };
		}
		if (entry.state === "active") {
			return { ok: false, code: "already_active", entryId };
		}
		for (const hook of uniqueHooks(entry.writes)) {
			const owner = this.owners.get(hook);
			if (owner !== undefined) {
				return { ok: false, code: "hook_occupied", entryId, hook, owner };
			}
		}
		for (const hook of uniqueHooks(entry.writes)) {
			this.owners.set(hook, entryId);
			if (options?.extension) {
				this.activators.set(hook, options.extension);
			}
		}
		entry.state = "active";
		return { ok: true, entryId };
	}

	deactivate(entryId: string, caller?: CutCaller): DeactivateStrategyResult {
		const entry = this.entries.get(entryId);
		if (!entry) {
			return { ok: false, code: "not_found", entryId };
		}
		if (!this.isEntryOwner(entryId, caller?.extension)) {
			return { ok: false, code: "not_owner", entryId };
		}
		if (entry.state !== "active") {
			return { ok: false, code: "not_active", entryId };
		}
		for (const hook of uniqueHooks(entry.writes)) {
			if (this.owners.get(hook) === entryId) {
				this.owners.delete(hook);
				this.activators.delete(hook);
				if (hook === WRITE_HOOK_REAL_CONTEXT) {
					this.cutPolicy = undefined;
				}
			}
		}
		entry.state = "inactive";
		return { ok: true, entryId };
	}

	delete(entryId: string, caller?: CutCaller): DeleteStrategyResult {
		const entry = this.entries.get(entryId);
		if (!entry) {
			return { ok: false, code: "not_found", entryId };
		}
		if (!this.isEntryOwner(entryId, caller?.extension)) {
			return { ok: false, code: "not_owner", entryId };
		}
		if (entry.state === "active") {
			return { ok: false, code: "still_active", entryId };
		}
		this.entries.delete(entryId);
		this.entryOwners.delete(entryId);
		return { ok: true, entryId };
	}

	private isEntryOwner(entryId: string, extension: string | undefined): boolean {
		const owner = this.entryOwners.get(entryId);
		return owner === undefined || owner === extension;
	}

	setCutPolicy(policy: CutPolicy, registrant: CutCaller): SetCutPolicyResult {
		if (this.activators.get(WRITE_HOOK_REAL_CONTEXT) !== registrant.extension) {
			return { ok: false, code: "not_hook_owner" };
		}
		this.cutPolicy = policy;
		return { ok: true };
	}

	authorizeCut(caller: CutCaller, cut: unknown): AuthorizeCutResult {
		const owner = this.owners.get(WRITE_HOOK_REAL_CONTEXT);
		if (!owner) {
			return { ok: false, code: "hook_not_owned" };
		}
		const activator = this.activators.get(WRITE_HOOK_REAL_CONTEXT);
		if (activator === caller.extension) {
			return { ok: true };
		}
		if (!this.cutPolicy) {
			return { ok: false, code: "not_hook_owner" };
		}
		const decision = this.cutPolicy(cut, caller);
		if (decision.accept) {
			return { ok: true };
		}
		return { ok: false, code: "cut_rejected", reason: decision.reason };
	}

	query(): StrategyQuerySnapshot {
		const entries: StrategyEntryRecord[] = [];
		const activeEntryIds: string[] = [];
		for (const entry of this.entries.values()) {
			entries.push({
				entryId: entry.entryId,
				implementationRef: entry.implementationRef,
				revision: entry.revision,
				reads: [...entry.reads],
				writes: [...entry.writes],
				state: entry.state,
			});
			if (entry.state === "active") {
				activeEntryIds.push(entry.entryId);
			}
		}
		return {
			entries,
			activeEntryIds,
			writeOwners: Object.fromEntries(this.owners),
		};
	}
}

/** Extension-visible occupancy table. Caller identity is injected; extensions cannot pass it. */
export interface ContextStrategyHandle {
	configure(request: ConfigureStrategyRequest): ConfigureStrategyResult;
	activate(entryId: string): ActivateStrategyResult;
	deactivate(entryId: string): DeactivateStrategyResult;
	delete(entryId: string): DeleteStrategyResult;
	query(): StrategyQuerySnapshot;
	setCutPolicy(policy: CutPolicy): SetCutPolicyResult;
}

export function bindContextStrategy(management: ContextStrategyManagement, caller: CutCaller): ContextStrategyHandle {
	return {
		configure: (request) => management.configure(request, caller),
		activate: (entryId) => management.activate(entryId, caller),
		deactivate: (entryId) => management.deactivate(entryId, caller),
		delete: (entryId) => management.delete(entryId, caller),
		query: () => management.query(),
		setCutPolicy: (policy) => management.setCutPolicy(policy, caller),
	};
}

function uniqueHooks(hooks: readonly string[]): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const hook of hooks) {
		if (seen.has(hook)) {
			continue;
		}
		seen.add(hook);
		ordered.push(hook);
	}
	return ordered;
}
