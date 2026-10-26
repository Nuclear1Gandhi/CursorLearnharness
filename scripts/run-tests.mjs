/**
 * Test runner that sets NODE_ENV=test on Windows and Unix alike.
 * npm's package.json script `NODE_ENV=test tsx ...` is Unix-only.
 */
import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.NODE_ENV = "test";
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const files = [
	...globSync("tests/*.test.ts", { cwd: root }),
	...globSync("tests/*.test.tsx", { cwd: root }),
].map((f) => path.join(root, f));

const child = spawn(process.execPath, [tsxCli, "--test", ...files], {
	stdio: "inherit",
	env: process.env,
	cwd: root,
});
child.on("exit", (code, signal) => {
	if (signal) process.exit(1);
	process.exit(code ?? 1);
});
