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
	| { ok: false; code: "not_found" | "already_active"; entryId: string }
	| { ok: false; code: "hook_occupied"; entryId: string; hook: string; owner: string };

export type DeactivateStrategyResult =
	| { ok: true; entryId: string }
	| { ok: false; code: "not_found" | "not_active"; entryId: string };

export type DeleteStrategyResult =
	| { ok: true; entryId: string }
	| { ok: false; code: "not_found" | "still_active"; entryId: string };

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
	private readonly owners = new Map<string, string>();

	configure(request: ConfigureStrategyRequest): ConfigureStrategyResult {
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
		return { ok: true, entryId };
	}

	activate(entryId: string): ActivateStrategyResult {
		const entry = this.entries.get(entryId);
		if (!entry) {
			return { ok: false, code: "not_found", entryId };
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
		}
		entry.state = "active";
		return { ok: true, entryId };
	}

	deactivate(entryId: string): DeactivateStrategyResult {
		const entry = this.entries.get(entryId);
		if (!entry) {
			return { ok: false, code: "not_found", entryId };
		}
		if (entry.state !== "active") {
			return { ok: false, code: "not_active", entryId };
		}
		for (const hook of uniqueHooks(entry.writes)) {
			if (this.owners.get(hook) === entryId) {
				this.owners.delete(hook);
			}
		}
		entry.state = "inactive";
		return { ok: true, entryId };
	}

	delete(entryId: string): DeleteStrategyResult {
		const entry = this.entries.get(entryId);
		if (!entry) {
			return { ok: false, code: "not_found", entryId };
		}
		if (entry.state === "active") {
			return { ok: false, code: "still_active", entryId };
		}
		this.entries.delete(entryId);
		return { ok: true, entryId };
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
