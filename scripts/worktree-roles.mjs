import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";

// Keep in sync with git/worktree.rs and the shared worktree-role-cases.json fixtures.
// Only settings.json + config.yml are native project settings sources in OMP.
const CONFIG_NAMES = ["settings.json", "config.yml", "config.yaml", "config.json", "settings.yml", "settings.yaml"];
const MAX_BYTES = 4 * 1024 * 1024;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exists = (file) => {
	try {
		fs.lstatSync(file);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
};

/** Seed only role assignments; existing project config (even a dangling link) is never touched. */
export function inheritWorktreeRoles(mainRoot, target) {
	if (fs.realpathSync(mainRoot) === fs.realpathSync(target)) return false;
	const dir = path.join(target, ".omp");
	const configured = () => CONFIG_NAMES.some((name) => exists(path.join(dir, name)));
	if (configured()) return false;
	const roles = Object.create(null);
	const overrides = Object.create(null);
	for (const name of ["settings.json", "config.yml"]) {
		const file = path.join(mainRoot, ".omp", name);
		if (!exists(file)) continue;
		const invalid = () => new Error(`无法继承角色配置：${file}（无效配置）`);
		const metadata = fs.statSync(file);
		if (!metadata.isFile() || metadata.size > MAX_BYTES) throw invalid();
		let value;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
			value = name.endsWith(".json") ? JSON.parse(text) : parse(text);
		} catch {
			throw invalid();
		}
		if (value == null) continue;
		if (!record(value)) throw invalid();
		const merge = (table, into) => {
			if (table === undefined) return;
			if (table === null) {
				for (const key of Object.keys(into)) delete into[key];
				return;
			}
			if (!record(table)) throw invalid();
			Object.assign(into, table);
		};
		merge(value.modelRoles, roles);
		merge(value.task?.agentModelOverrides, overrides);
	}
	const value = {};
	if (Object.keys(roles).length) value.modelRoles = roles;
	if (Object.keys(overrides).length) value.task = { agentModelOverrides: overrides };
	if (!Object.keys(value).length) return false;
	// Refuse directory links rather than writing outside the target worktree.
	if (exists(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(`无法继承角色配置：${dir} 是符号链接`);
	fs.mkdirSync(dir, { recursive: true });
	if (configured()) return false;
	const temporary = path.join(dir, `.role-inherit-${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(temporary, stringify(value), { flag: "wx", mode: 0o600 });
		// Publish a complete file atomically without replacing a concurrent writer.
		try {
			fs.linkSync(temporary, path.join(dir, "config.yml"));
		} catch (error) {
			if (error.code === "EEXIST") return false;
			throw error;
		}
	} finally {
		fs.rmSync(temporary, { force: true });
	}
	return true;
}
