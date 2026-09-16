// Controlled loopback provider for process tests. No paid service or user credentials.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function localCompletions() {
	const requests = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		const parsed = JSON.parse(body);
		requests.push(parsed);
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = (delta, finish_reason) => `data: ${JSON.stringify({
			id: "controlled-completion", object: "chat.completion.chunk", created: 1, model: "s2-loopback",
			choices: [{ index: 0, delta, finish_reason }],
		})}\n\n`;
		response.write(chunk({ role: "assistant", content: "S2_LOCAL_OK" }, null));
		response.write(chunk({}, "stop"));
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}/v1`,
		requests,
		close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
	};
}

export function configureLocalHome(root, baseUrl) {
	const agentDir = join(root, ".kappa", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
		"s2-loopback": { baseUrl, api: "openai-completions", apiKey: "local-test-only", models: [{ id: "s2-loopback" }] },
	} }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "s2-loopback", defaultModel: "s2-loopback", autoUpdate: false,
		retry: { enabled: false }, compaction: { enabled: false },
	}));
	return {
		PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
		COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT,
		HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
		PI_CODING_AGENT_DIR: join(root, "poison-pi-agent"),
		PI_TELEMETRY: "0", PI_OFFLINE: "1", NO_COLOR: "1",
	};
}
