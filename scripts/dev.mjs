// `pnpm dev`: ensure an initial mobile build exists (the Rust server embeds it), then run
// the mobile watcher alongside the desktop Vite server. Both children die with this process.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bin = (name) => fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));
const mobileArgs = ["build", "--config", "vite.mobile.config.ts"];
const mobileIndex = fileURLToPath(new URL("../src-tauri/mobile-dist/index.html", import.meta.url));

if (!existsSync(mobileIndex)) {
	const first = spawnSync(bin("vite"), mobileArgs, { stdio: "inherit" });
	if (first.status !== 0) process.exit(first.status ?? 1);
}

const children = [
	spawn(bin("vite"), [...mobileArgs, "--watch"], { stdio: "inherit" }),
	spawn(bin("vite"), process.argv.slice(2), { stdio: "inherit" }),
];
const stop = (code) => {
	for (const c of children) c.kill();
	process.exit(code ?? 0);
};
children[1].on("exit", stop);
children[0].on("exit", (code) => code && stop(code));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => stop(0));
