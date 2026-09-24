/**
 * Core modules shared between all run modes.
 */

export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.ts";
export {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
export {
	AGENT_SUBJECT_SCHEMA_VERSION,
	AgentSubject,
	type AgentSubjectAbortResult,
	type AgentSubjectCause,
	type AgentSubjectEvent,
	type AgentSubjectEventType,
	type AgentSubjectIdentity,
	type AgentSubjectObserveResult,
	type AgentSubjectOptions,
	type AgentSubjectProvenance,
	type AgentSubjectRefused,
	type AgentSubjectResult,
	type AgentSubjectSettledResult,
	type AgentSubjectStartResult,
	type AgentSubjectSubmitInput,
	type AgentSubjectSubmitResult,
	type AgentSubjectUnknown,
	type AgentSubjectUnsupported,
	createAgentSubject,
} from "./agent-subject.ts";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
export {
	C2_CLAIM_SCHEMA_VERSION,
	type C2ClaimAdmission,
	type C2ClaimReceipt,
	type C2ClaimRefusal,
	KAPPA_SOURCE_PIN,
	sealC2ClaimReceipt,
} from "./c2-claim-receipt.ts";
export {
	C2_EMPTY_LEAF_ID,
	type C2Accepted,
	type C2CallOptions,
	C2Ingress,
	type C2IngressRecord,
	type C2Kind,
	type C2Provenance,
	type C2Refused,
	C2RefusedError,
	type C2Result,
	type C2RevisionProvider,
	type C2Source,
} from "./c2-ingress.ts";
export type { CompactionResult } from "./compaction/index.ts";
export {
	type ActivateStrategyResult,
	type AuthorizeCutResult,
	bindContextStrategy,
	CONTEXT_STRATEGY_DEFAULT_ENTRY_ID,
	type ConfigureStrategyRequest,
	type ConfigureStrategyResult,
	type ContextStrategyHandle,
	ContextStrategyManagement,
	type CutCaller,
	type CutDecision,
	type CutPolicy,
	type DeactivateStrategyResult,
	type DeleteStrategyResult,
	type SetCutPolicyResult,
	type StrategyEntryRecord,
	type StrategyEntryState,
	type StrategyQuerySnapshot,
	WRITE_HOOK_CONTEXT_ARTIFACTS,
	WRITE_HOOK_REAL_CONTEXT,
} from "./context-strategy/management.ts";
export {
	NATIVE_COMPACTION_DISABLED_CODE,
	NATIVE_COMPACTION_DISABLED_MESSAGE,
} from "./context-strategy/native-compaction.ts";
export {
	type CommitWorkingSetCutResult,
	commitWorkingSetCut,
	type WorkingSetCut,
} from "./context-strategy/working-set-cut.ts";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
export { areExperimentalFeaturesEnabled } from "./experimental.ts";
// Extensions system
export {
	type AgentEndEvent,
	type AgentSettledEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ContextEvent,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type InlineExtension,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
