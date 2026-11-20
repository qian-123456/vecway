/**
 * Right-panel file preview tabs: one tab per opened file (Chrome-style, like
 * side-chat and terminal instances). Kept separate from `stores/ui.ts` so the
 * tab list survives panel switches and closing a file only closes its own tab.
 */

import { create } from "zustand";
import { toast } from "../lib/toast";
import { tNow } from "./language";
import {
	canPreviewFile,
	decodeFilePath,
	resolveFilePath,
	stripLineSuffix,
	stripMentionPrefix,
} from "../lib/fileLinks";
import { basename } from "../lib/paths";
import { listWorkspaceFiles, validatePath } from "../lib/ipc";
import { useUi } from "./ui";
import { useSessions } from "./sessions";
import { useLive } from "./live";

export type FileViewMode = "preview" | "edit";

export interface FileTab {
	/** Absolute path (or `~/…` when the home dir is unknown). */
	path: string;
	/** Directory relative link targets are resolved against. */
	cwd: string | null;
	mode: FileViewMode;
}

interface FilePreviewState {
	tabs: FileTab[];
	activePath: string | null;
	/** Open (or focus) a file tab; text files start in preview. */
	openFile(path: string, opts?: { cwd?: string | null; mode?: FileViewMode }): void;
	closeFile(path: string): void;
	setActive(path: string): void;
	setMode(path: string, mode: FileViewMode): void;
}

/** Collapse `//`, `/./` and a trailing slash so one file never gets two tabs. */
export function normalizeTabPath(p: string): string {
	const lead = p.startsWith("/") ? "/" : "";
	const parts = p.split("/").filter((seg) => seg !== "" && seg !== ".");
	return lead + parts.join("/") || p;
}

export const useFilePreview = create<FilePreviewState>((set, get) => ({
	tabs: [],
	activePath: null,
	openFile: (rawPath, opts) => {
		const path = normalizeTabPath(rawPath);
		const cwd = opts?.cwd ?? null;
		set((s) => {
			const existing = s.tabs.find((t) => t.path === path);
			const tabs = existing
				? s.tabs.map((t) =>
						t.path === path
							? { ...t, cwd: cwd ?? t.cwd, mode: opts?.mode ?? t.mode }
							: t,
					)
				: [...s.tabs, { path, cwd, mode: opts?.mode ?? "preview" }];
			return { tabs, activePath: path };
		});
		useUi.getState().setRightTab("files");
	},
	closeFile: (path) => {
		const { tabs, activePath } = get();
		const idx = tabs.findIndex((t) => t.path === path);
		if (idx < 0) return;
		const next = tabs.filter((t) => t.path !== path);
		const nextActive =
			activePath === path ? (next[idx]?.path ?? next[idx - 1]?.path ?? null) : activePath;
		set({ tabs: next, activePath: nextActive });
		if (next.length === 0) useUi.getState().closeRightTab("files");
	},
	setActive: (path) => set({ activePath: path }),
	setMode: (path, mode) =>
		set((s) => ({
			tabs: s.tabs.map((t) => (t.path === path ? { ...t, mode } : t)),
		})),
}));

interface OpenFileLinkOptions {
	/** Session working directory used to resolve relative paths. */
	cwd?: string | null;
	/** User home directory, for `~/…` targets. */
	home?: string | null;
	/** Session id used to resolve `local://` and session-local plan artifacts. */
	sessionId?: string | null;
}

async function exists(path: string): Promise<boolean> {
	try {
		const check = await validatePath(path);
		return check.exists && !check.isDir;
	} catch {
		return false;
	}
}

/**
 * Resolve `local://<rel>` or a missing absolute path (e.g. a hallucinated
 * external artifact directory) against the session's `planFile` or `<session>/local/`.
 */
async function resolveSessionLocalFile(
	nameOrRel: string,
	sessionId: string | null | undefined,
	{ matchBasename }: { matchBasename: boolean },
): Promise<{ path: string | null; found: boolean }> {
	const sid = sessionId ?? useUi.getState().selectedSessionId;
	if (!sid) return { path: null, found: false };
	const clean = nameOrRel.replace(/^\/+/, "");
	if (!clean || clean.split("/").some((seg) => seg === "..")) {
		return { path: null, found: false };
	}
	const metaFile = useSessions.getState().sessions[sid]?.file;
	const localCandidate =
		metaFile && /\.jsonl$/i.test(metaFile)
			? `${metaFile.replace(/\.jsonl$/i, "")}/local/${matchBasename ? basename(clean) : clean}`
			: null;
	if (localCandidate && (await exists(localCandidate))) {
		return { path: localCandidate, found: true };
	}
	const plan = useLive.getState().sessions[sid]?.plan;
	const targetName = basename(clean);
	for (const candidate of [plan?.planFile, plan?.approved?.planFile]) {
		if (!candidate) continue;
		const matches = matchBasename
			? basename(candidate) === targetName
			: candidate.endsWith(`/${clean}`) || (!clean.includes("/") && basename(candidate) === clean);
		if (matches && (await exists(candidate))) {
			return { path: candidate, found: true };
		}
	}
	return { path: localCandidate, found: false };
}

/**
 * Find the file a link points at. Agents write relative paths against different
 * roots, so try the session cwd, its ancestors (repo-name prefixes), the home
 * directory and every open workspace, then fall back to a workspace file search.
 * Absolute paths check disk first and fall back to session-local artifacts
 * before trusting the raw path so the panel shows read errors in place.
 */
async function locateFile(
	raw: string,
	opts: OpenFileLinkOptions,
): Promise<{ path: string; found: boolean }> {
	const token = decodeFilePath(stripMentionPrefix(
		stripLineSuffix(raw.trim())
			.replace(/^file:\/\//i, "")
			.replace(/[?#].*$/, ""),
	));
	if (/^local:\/\//i.test(token)) {
		const rel = token.replace(/^local:\/\//i, "");
		const resolved = await resolveSessionLocalFile(rel, opts.sessionId, { matchBasename: false });
		if (resolved.found && resolved.path) return { path: resolved.path, found: true };
		return { path: resolved.path || token, found: false };
	}
	if (token.startsWith("/")) {
		if (await exists(token)) return { path: token, found: true };
		const fallback = await resolveSessionLocalFile(token, opts.sessionId, { matchBasename: true });
		if (fallback.found && fallback.path) return { path: fallback.path, found: true };
		return { path: token, found: true };
	}
	const candidates: string[] = [];
	const add = (p: string | undefined | null) => {
		if (p && !candidates.includes(p)) candidates.push(p);
	};
	const rel = token.replace(/^\.\//, "");
	if (token.startsWith("~/")) {
		// Home-relative: only the home dir (and the literal path) apply.
		const expanded = opts.home
			? `${opts.home.replace(/\/+$/, "")}/${token.slice(2)}`
			: token;
		if (await exists(expanded)) return { path: expanded, found: true };
		return { path: expanded, found: false };
	}
	// Agents often prefix the repo name (`omp-workspace/src/x.ts`) while the
	// session runs inside a worktree, so try the cwd's ancestors as well.
	const ancestors: string[] = [];
	for (let dir = opts.cwd; dir && dir !== "/"; dir = dir.slice(0, dir.lastIndexOf("/"))) {
		if (dir === opts.home) break;
		ancestors.push(dir);
		if (ancestors.length >= 4) break;
	}
	const roots = [
		opts.cwd,
		...ancestors,
		opts.home,
		...useSessions.getState().workspaces.map((w) => w.path),
	].filter((r): r is string => !!r);
	for (const root of roots) add(`${root.replace(/\/+$/, "")}/${rel}`);

	for (const candidate of candidates) {
		if (await exists(candidate)) return { path: candidate, found: true };
	}
	for (const root of roots) {
		try {
			// Entries are paths relative to `root`; a leading repo-name segment
			// (`omp-workspace/AGENTS.md`) is dropped when it names the root itself.
			const files = await listWorkspaceFiles(root);
			const rootName = root.slice(root.lastIndexOf("/") + 1);
			const local = rel.startsWith(`${rootName}/`) ? rel.slice(rootName.length + 1) : rel;
			const matches = files
				.filter((f) => f === rel || f === local || f.endsWith(`/${rel}`))
				.sort((a, b) => a.length - b.length);
			if (matches[0]) {
				return { path: `${root.replace(/\/+$/, "")}/${matches[0]}`, found: true };
			}
		} catch {
			/* listing is best-effort */
		}
	}
	return { path: candidates[0] || resolveFilePath(raw, opts) || token, found: false };
}

/**
 * Open a file the agent linked. Text and images open as a right-panel tab
 * (preview by default). Anything the panel cannot render as human-readable
 * text or an image is refused with a toast — a link in an answer must never
 * hand an arbitrary path (`.app`, `.command`, `.sh`, …) to the system opener.
 */
export async function openFileLink(
	raw: string,
	opts: OpenFileLinkOptions = {},
): Promise<void> {
	const { path, found } = await locateFile(raw, opts);
	if (!path) {
		toast.error(tNow("shell.cannotLocateFileNoCwd", { raw }));
		return;
	}
	if (!found) {
		toast.error(tNow("shell.fileNotFound", { raw, path }));
		return;
	}
	if (!canPreviewFile(path)) {
		toast.error(tNow("shell.blockedPreviewNonTextOrImage", { name: basename(path) }));
		return;
	}
	useFilePreview.getState().openFile(path, { cwd: opts.cwd ?? null });
}
