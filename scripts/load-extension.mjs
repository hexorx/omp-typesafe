import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent";

process.env.OMP_TYPESAFE_ENABLED = "1";
process.env.TYPESAFE_API_KEY = "offline-test-key-0123456789";
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "omp-typesafe-load-"));
globalThis.fetch = async () => Response.json({
  model: "jev-test",
  answers: { yes: { type: "noul", noul: 0.5 } },
  usage: { input_tokens: 3, output_tokens: 0 },
});

const entry = new URL("../dist/extension.js", import.meta.url).pathname;
const result = await loadExtensions([entry], process.cwd());
assert.deepEqual(result.errors, [], "omp must load the extension");
const loaded = result.extensions[0];
assert.ok(loaded);
assert.ok(loaded.tools.has("typesafe_evaluate"));
assert.ok(loaded.commands.has("typesafe"));
const tool = loaded.tools.get("typesafe_evaluate");
const evaluated = await tool.definition.execute("load-check", {
  state: "synthetic",
  questions: { yes: { type: "noul", instructions: "Is this synthetic?", criteria: "synthetic data" } },
}, undefined, undefined, { hasUI: false, ui: { notify() {} } });
assert.equal(evaluated.details.answers.yes.noul, 0.5);
console.log("omp loaded typesafe_evaluate and /typesafe");
