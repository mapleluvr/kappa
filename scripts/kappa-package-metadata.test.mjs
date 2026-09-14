import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
}

test("Kappa workspace metadata follows the approved Pi monorepo shape", async () => {
  const workspace = await readJson("package.json");
  const codingAgent = await readJson("packages/coding-agent/package.json");
  const tui = await readJson("packages/tui/package.json");

  assert.equal(workspace.name, "kappa");
  assert.equal(workspace.private, true);
  assert.ok(workspace.workspaces.includes("packages/*"));

  for (const [manifest, packageName, directory] of [
    [codingAgent, "@mapleluvr/kappa-coding-agent", "packages/coding-agent"],
    [tui, "@mapleluvr/kappa-tui", "packages/tui"],
  ]) {
    assert.equal(manifest.name, packageName);
    assert.equal(manifest.version, "0.85.1");
    assert.deepEqual(manifest.repository, {
      type: "git",
      url: "git+https://github.com/mapleluvr/kappa.git",
      directory,
    });
  }

  assert.equal(codingAgent.dependencies["@mapleluvr/kappa-tui"], "0.85.1");
  assert.equal(codingAgent.dependencies["@earendil-works/pi-tui"], undefined);
});

test("generated coding-agent release locks include renamed internal workspaces", () => {
  for (const script of ["scripts/generate-coding-agent-install-lock.mjs", "scripts/generate-coding-agent-shrinkwrap.mjs"]) {
    const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    assert.equal(result.status, 0, `${script} failed:\n${result.stdout}\n${result.stderr}`);
  }
});
