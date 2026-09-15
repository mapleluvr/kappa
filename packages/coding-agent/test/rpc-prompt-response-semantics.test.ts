import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: { withAuth: boolean; responseDelayMs: number; model?: Model<any> }): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	if (options.withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				await session.abort();
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: { withAuth: boolean; responseDelayMs: number; model?: Model<any> }): Promise<{
	lineHandler: (line: string) => void;
	session: AgentSession;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	const signalListeners = new Map(
		(["SIGTERM", "SIGHUP"] as const).map((signal) => [signal, process.listeners(signal)]),
	);
	const endListeners = process.stdin.listeners("end");
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		lineHandler: rpcIo.lineHandler!,
		session: runtimeHost.session,
		cleanup: async () => {
			try {
				await cleanup();
			} finally {
				for (const [signal, previous] of signalListeners) {
					for (const listener of process.listeners(signal)) {
						if (!previous.includes(listener)) process.off(signal, listener);
					}
				}
				for (const listener of process.stdin.listeners("end")) {
					if (!endListeners.includes(listener)) process.stdin.off("end", listener as () => void);
				}
			}
		},
	};
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it.each(["prompt", "steer", "follow_up"] as const)(
		"replays the same RPC %s id after persistence moves the leaf",
		async (type) => {
			const { lineHandler, session, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
			const command = { id: `replay-${type}`, type, message: "once" };
			const responses = () =>
				parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === command.id && record.type === "response",
				);
			try {
				lineHandler(JSON.stringify(command));
				await vi.waitFor(() => expect(responses()).toHaveLength(1));
				if (type !== "prompt") {
					lineHandler(JSON.stringify({ id: "drain", type: "prompt", message: "start" }));
					await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, "drain")).toHaveLength(1));
				}
				await session.waitForIdle();
				const entryIds = session.sessionManager.getEntries().map((entry) => entry.id);
				const runCount = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.type === "agent_start",
				).length;
				lineHandler(JSON.stringify(command));
				await vi.waitFor(() => expect(responses()).toHaveLength(2));
				await session.waitForIdle();
				expect(responses()[1]).toMatchObject({ success: true });
				expect(session.getC2Result(command.id)).toMatchObject({
					status: "accepted",
					replayed: true,
					record: { idempotencyKey: command.id },
				});
				expect(session.sessionManager.getEntries().map((entry) => entry.id)).toEqual(entryIds);
				expect(session.pendingMessageCount).toBe(0);
				expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_start")).toHaveLength(
					runCount,
				);
			} finally {
				await cleanup();
			}
		},
	);

	it("keeps the RPC admission identity after a conflicting retry", async () => {
		const { lineHandler, session, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		const command = { id: "replay-conflict", type: "prompt", message: "once" };
		try {
			lineHandler(JSON.stringify(command));
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, command.id)).toHaveLength(1));
			await session.waitForIdle();
			const entryIds = session.sessionManager.getEntries().map((entry) => entry.id);
			lineHandler(JSON.stringify({ ...command, message: "different" }));
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, command.id)).toHaveLength(2));
			expect(getPromptResponses(rpcIo.outputLines, command.id)[1]).toMatchObject({ success: false });
			lineHandler(JSON.stringify(command));
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, command.id)).toHaveLength(3));
			await session.waitForIdle();
			expect(session.getC2Result(command.id)).toMatchObject({ status: "accepted", replayed: true });
			expect(session.sessionManager.getEntries().map((entry) => entry.id)).toEqual(entryIds);
		} finally {
			await cleanup();
		}
	});

	it.each(["steer", "follow_up"] as const)("re-admits a released RPC %s id after the leaf moves", async (type) => {
		const { lineHandler, session, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		const command = { id: `released-${type}`, type, message: "retry after clear" };
		const responses = () =>
			parseOutputLines(rpcIo.outputLines).filter((record) => record.id === command.id && record.type === "response");
		try {
			lineHandler(JSON.stringify(command));
			await vi.waitFor(() => expect(responses()).toHaveLength(1));
			lineHandler(JSON.stringify({ id: "remove-queued", type: "clear_queue" }));
			await vi.waitFor(() => expect(session.pendingMessageCount).toBe(0));
			await session.prompt("move the leaf");
			lineHandler(JSON.stringify(command));
			await vi.waitFor(() => expect(responses()).toHaveLength(2));
			expect(responses()[1]).toMatchObject({ success: true });
			expect(session.pendingMessageCount).toBe(1);
			await session.prompt("drain retry");
			const users = session.sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "message" && entry.message.role === "user" ? [entry.message] : []));
			expect(users.filter((message) => JSON.stringify(message.content).includes(command.message))).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	it("re-admits an RPC prompt after streaming preflight releases its identity", async () => {
		const { lineHandler, session, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 150 });
		const command = { id: "preflight-retry", type: "prompt", message: "retry input" };
		try {
			lineHandler(JSON.stringify({ id: "active", type: "prompt", message: "in flight" }));
			await vi.waitFor(() => expect(session.isStreaming).toBe(true));
			lineHandler(JSON.stringify(command));
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, command.id)).toHaveLength(1));
			expect(getPromptResponses(rpcIo.outputLines, command.id)[0]).toMatchObject({ success: false });
			await session.waitForIdle();
			lineHandler(JSON.stringify(command));
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, command.id)).toHaveLength(2));
			expect(getPromptResponses(rpcIo.outputLines, command.id)[1]).toMatchObject({ success: true });
			await session.waitForIdle();
			expect(session.messages.filter((message) => message.role === "user")).toHaveLength(2);
		} finally {
			await cleanup();
		}
	});

	it("does not pin a refused RPC id to an earlier leaf or revision", async () => {
		const { lineHandler, session, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		const command = { id: "refused-retry", type: "prompt", message: "retry input" };
		try {
			lineHandler(JSON.stringify({ ...command, baseRevision: 999 }));
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, command.id)).toHaveLength(1));
			expect(session.getC2Result(command.id)).toMatchObject({ status: "refused", code: "revision_conflict" });
			await session.prompt("move the leaf");
			lineHandler(JSON.stringify(command));
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, command.id)).toHaveLength(2));
			expect(getPromptResponses(rpcIo.outputLines, command.id)[1]).toMatchObject({ success: true });
			await session.waitForIdle();
			expect(session.messages.filter((message) => message.role === "user")).toHaveLength(2);
		} finally {
			await cleanup();
		}
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it("returns and clears queued steering and follow-up messages", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 500 });

		try {
			lineHandler(JSON.stringify({ id: "clear-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-start")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-steering",
					type: "prompt",
					message: "Change direction",
					streamingBehavior: "steer",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-steering")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-follow-up",
					type: "prompt",
					message: "Summarize when finished",
					streamingBehavior: "followUp",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-follow-up")).toHaveLength(1);
			});

			lineHandler(JSON.stringify({ id: "clear", type: "clear_queue" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "clear",
					type: "response",
					command: "clear_queue",
					success: true,
					data: {
						steering: ["Change direction"],
						followUp: ["Summarize when finished"],
					},
				});
			});

			await sleep(600);
			expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_start")).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});
});
