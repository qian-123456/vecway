import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { inheritWorktreeRoles } from "./worktree-roles.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "worktree-role-cases.json"), "utf8"));
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-worktree-roles-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const main = path.join(root, "main");
	const target = path.join(root, "linked");
	fs.mkdirSync(main);
	fs.mkdirSync(target);
	const write = (base, files) => {
		for (const [name, text] of Object.entries(files ?? {})) {
			fs.mkdirSync(path.join(base, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(base, ".omp", name), text);
		}
	};
	return { root, main, target, write };
}

for (const c of cases) {
	test(`shared role inheritance: ${c.name}`, (t) => {
		const f = fixture(t);
		f.write(f.main, c.source);
		f.write(f.target, c.target);
		if (c.error) {
			assert.throws(() => inheritWorktreeRoles(f.main, f.target), /无效配置/);
			assert.equal(fs.existsSync(path.join(f.target, ".omp")), false);
		} else {
			const written = inheritWorktreeRoles(f.main, f.target);
			assert.equal(written, c.expected != null);
			const output = path.join(f.target, ".omp", "config.yml");
			if (c.expected != null) assert.deepEqual(parse(fs.readFileSync(output, "utf8")), c.expected);
			else if (!Object.hasOwn(c.target ?? {}, "config.yml")) assert.equal(fs.existsSync(output), false);
			for (const [name, text] of Object.entries(c.target ?? {})) {
				assert.equal(fs.readFileSync(path.join(f.target, ".omp", name), "utf8"), text);
			}
		}
		for (const [name, text] of Object.entries(c.source)) {
			assert.equal(fs.readFileSync(path.join(f.main, ".omp", name), "utf8"), text);
		}
	});
}

test("main is untouched and linked config directories are not followed", (t) => {
	const f = fixture(t);
	f.write(f.main, { "config.yml": "modelRoles:\n  default: provider/main\n" });
	assert.equal(inheritWorktreeRoles(f.main, f.main), false);
	const outside = path.join(f.root, "outside");
	fs.mkdirSync(outside);
	fs.symlinkSync(outside, path.join(f.target, ".omp"));
	assert.throws(() => inheritWorktreeRoles(f.main, f.target), /符号链接/);
	assert.deepEqual(fs.readdirSync(outside), []);
});

test("oversized, non-UTF8 and broken source links fail without partial files", (t) => {
	const f = fixture(t);
	const file = path.join(f.main, ".omp/config.yml");
	for (const content of ["x".repeat(4 * 1024 * 1024 + 1), Buffer.from([0xff])]) {
		f.write(f.main, { "config.yml": content });
		assert.throws(() => inheritWorktreeRoles(f.main, f.target), /无效配置/);
		assert.equal(fs.existsSync(path.join(f.target, ".omp")), false);
	}
	fs.unlinkSync(file);
	fs.symlinkSync(path.join(f.root, "missing"), file);
	assert.throws(() => inheritWorktreeRoles(f.main, f.target), /ENOENT/);
	assert.equal(fs.existsSync(path.join(f.target, ".omp")), false);
});

test("a dangling target config link protects the entire target layer", (t) => {
	const f = fixture(t);
	f.write(f.main, { "config.yml": "modelRoles:\n  default: provider/main\n" });
	fs.mkdirSync(path.join(f.target, ".omp"));
	const file = path.join(f.target, ".omp/config.yml");
	fs.symlinkSync(path.join(f.root, "missing"), file);
	assert.equal(inheritWorktreeRoles(f.main, f.target), false);
	assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});

function launcher(t) {
	const f = fixture(t);
	const git = (...args) => {
		const result = spawnSync("git", ["-C", f.main, ...args], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	};
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	git("config", "commit.gpgsign", "false");
	git("commit", "-q", "--allow-empty", "-m", "init");
	fs.rmdirSync(f.target);
	git("worktree", "add", "-q", "-b", "linked", f.target);
	const scripts = path.join(f.target, "scripts");
	fs.mkdirSync(scripts);
	for (const name of ["open-worktree.mjs", "worktree-roles.mjs"]) {
		fs.copyFileSync(path.join(SCRIPTS, name), path.join(scripts, name));
	}
	// Use the existing parser dependency; never install packages or start a real app.
	fs.symlinkSync(path.resolve(SCRIPTS, "../node_modules"), path.join(f.target, "node_modules"));
	const bin = path.join(f.root, "bin");
	fs.mkdirSync(bin);
	for (const name of ["lsof", "ps"]) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	const marker = path.join(f.root, "consumed.yml");
	fs.writeFileSync(path.join(bin, "pnpm"), '#!/bin/sh\ncat .omp/config.yml > "$ROLE_TEST_MARKER"\nprintf "error: could not compile (launcher fixture only)\\n"\n', { mode: 0o700 });
	const run = (...args) => spawnSync(process.execPath, [path.join(scripts, "open-worktree.mjs"), "linked", "--timeout", "1", ...args], {
		encoding: "utf8",
		timeout: 10000,
		env: { ...process.env, HOME: f.root, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ROLE_TEST_MARKER: marker },
	});
	return { ...f, run, marker };
}

test("actual launcher in a linked checkout seeds from Git primary before the child consumes cwd", (t) => {
	const f = launcher(t);
	f.write(f.main, {
		"settings.json": '{"modelRoles":{"custom":"provider/custom","default":"provider/json"}}',
		"config.yml": "modelRoles:\n  default: provider/main\ntask:\n  agentModelOverrides:\n    scout: provider/fast\nprivate: never-copy\n",
	});
	const dry = f.run("--dry-run");
	assert.ifError(dry.error);
	assert.equal(dry.status, 0, dry.stderr);
	assert.equal(fs.existsSync(path.join(f.target, ".omp")), false);
	assert.equal(fs.existsSync(f.marker), false);
	const started = f.run();
	assert.ifError(started.error);
	// The fake child exits intentionally, after reading the exact runtime config.
	assert.equal(started.status, 1);
	assert.deepEqual(parse(fs.readFileSync(f.marker, "utf8")), {
		modelRoles: { custom: "provider/custom", default: "provider/main" },
		task: { agentModelOverrides: { scout: "provider/fast" } },
	});
	const own = "modelRoles:\n  default: provider/own\n";
	f.write(f.target, { "config.yml": own });
	f.run();
	assert.equal(fs.readFileSync(f.marker, "utf8"), own);
});

test("actual launcher reports bad source without spawning or writing target config", (t) => {
	const f = launcher(t);
	f.write(f.main, { "config.yml": "modelRoles: [" });
	const result = f.run();
	assert.ifError(result.error);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /role inheritance failed/);
	assert.match(result.stderr, /config.yml/);
	assert.equal(fs.existsSync(f.marker), false);
	assert.equal(fs.existsSync(path.join(f.target, ".omp")), false);
});
