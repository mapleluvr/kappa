import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NativeSubjectObserver } from "./lib/native-subject-observer.mjs";
import { configureLocalHome, localCompletions } from "./test-utils/local-completions.mjs";

const cli = fileURLToPath(new URL("../packages/coding-agent/dist/bundle/cli.js", import.meta.url));
const common = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "--provider", "s2-loopback", "--model", "s2-loopback"];

for (const mode of ["rpc", "json"]) {
	test(`observes a real ${mode} child without mixing adapter envelopes into stdout`, { timeout: 30_000 }, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "kappa-native-"));
		const provider = await localCompletions();
		t.after(async () => { await provider.close(); rmSync(root, { recursive: true, force: true }); });
		const observer = new NativeSubjectObserver({ runId: `run-${mode}` });
		const child = spawn(process.execPath, [cli, "--mode", mode, ...common, ...(mode === "json" ? ["S2_NATIVE_PROMPT"] : [])], {
			cwd: root, env: configureLocalHome(root, provider.url), stdio: ["pipe", "pipe", "pipe"],
		});
		t.after(() => { if (child.exitCode === null) child.kill(); });
		assert.ok(child.pid > 0);
		const frames = [];
		let buffer = "";
		let stderr = "";
		let parseError;
		child.stderr.on("data", (data) => { stderr += data; });
		child.stdout.on("data", (data) => {
			buffer += data;
			const lines = buffer.split("\n");
			buffer = lines.pop();
			for (const line of lines) {
				try {
					const frame = JSON.parse(line);
					frames.push(frame);
					observer.accept(frame);
					if (frame.type === "agent_settled" && mode === "rpc") child.stdin.end();
				} catch (error) { parseError = error; child.kill(); }
			}
		});
		if (mode === "rpc") {
			child.stdin.write(`${JSON.stringify({ id: "s2-request", type: "prompt", message: "S2_NATIVE_PROMPT" })}\n`);
		} else child.stdin.end();
		const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
		assert.ifError(parseError);
		assert.equal(code, 0, stderr);
		assert.equal(buffer.trim(), "");
		assert.equal(provider.requests.length, 1, stderr);
		assert.ok(provider.requests[0].messages.some((message) => message.role === "user"));
		assert.ok(frames.every((frame) => frame.schemaVersion === undefined), "adapter envelope leaked into stdout");
		const events = observer.observe().events;
		assert.deepEqual(events.map((event) => event.type), ["agent.accepted", "agent.running", "agent.agent_end", "agent.agent_settled"]);
		assert.equal(observer.settled().kind, "ok");
		const identity = events[0].identity;
		assert.ok(identity.sessionId && identity.branchId && identity.requestId);
		assert.equal(identity.runId, `run-${mode}`);
		assert.ok(events.every((event) => event.identity.sessionId === identity.sessionId && event.identity.requestId === identity.requestId));
		assert.deepEqual(observer.observe(events[1].cursor).events.map((event) => event.type), ["agent.agent_end", "agent.agent_settled"]);
		assert.equal(observer.observe("9999").code, "unknown_cursor");
		// Durable native session is in the Kappa scope despite the inherited Pi override.
		const header = mode === "json" ? frames.find((frame) => frame.type === "session") : undefined;
		if (header) assert.equal(header.id, identity.sessionId);
		const userEnd = frames.find((frame) => frame.type === "message_end" && frame.message?.role === "user");
		assert.ok(userEnd);
		assert.ok(frames.some((frame) => frame.type === "message_end" && frame.message?.role === "assistant" && frame.message?.stopReason === "stop"));
	});
}

test("does not turn process exit, idle or foreign settlement into a settled request", () => {
	const observer = new NativeSubjectObserver({ runId: "run-unsettled" });
	assert.equal(observer.settled().kind, "unknown");
	assert.throws(() => observer.accept({ type: "agent_settled" }), /admission/);
	assert.equal(observer.settled().kind, "unknown");
	assert.throws(() => observer.accept({ schemaVersion: "s1-draft-1", type: "agent.agent_settled" }), /native/);
});
