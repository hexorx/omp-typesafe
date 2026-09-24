import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadEnvFile } from "node:process";

const root = fileURLToPath(new URL("../", import.meta.url));
const built = spawnSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
if (built.status) process.exit(built.status ?? 1);
try {
  loadEnvFile(join(root, ".env"));
} catch {
  // No .env present; the stored key from /typesafe login (if any) is used.
}
const child = spawn("omp", ["--no-extensions", "-e", join(root, "dist/extension.js"), ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
child.on("error", () => {
  console.error("Could not start omp. Install the omp CLI and make it available on PATH.");
  process.exitCode = 1;
});
child.on("exit", code => { process.exitCode = code ?? 1; });
