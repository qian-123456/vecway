import { ChevronRight, FileDiff } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { DiffView, looksLikeDiff } from "../../../ui";
import type { Step } from "../lib/turns";

export type TurnDiffStatus = "A" | "M" | "D";

export interface TurnDiffFileEntry {
	path: string;
	status: TurnDiffStatus;
	adds: number;
	dels: number;
	diff: string | null;
	hasCounts: boolean;
}

export interface TurnDiffSummary {
	files: TurnDiffFileEntry[];
	totalAdds: number;
	totalDels: number;
	hasAnyCounts: boolean;
}

const WRITE_TOOLS = new Set(["write", "write_file"]);
const EDIT_TOOLS = new Set(["edit", "edit_file", "ast_edit", "write", "write_file", "apply_patch"]);
const PATH_ARG_KEYS = ["path", "file", "file_path", "filePath", "target_file", "targetFile"] as const;
const HASHLINE_HEADER_RE = /^\[([^\]#]+)#([0-9A-Za-z]+)\]$/;

const STATUS_CHIP_STYLE: Record<TurnDiffStatus, string> = {
	A: "bg-m-success-bg text-m-success",
	M: "bg-m-warn-bg text-m-warn",
	D: "bg-m-danger-bg text-m-danger",
};

const STATUS_TITLE: Record<TurnDiffStatus, string> = {
	A: "新增",
	M: "修改",
	D: "删除",
};

function asObj(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

export function normalizeTurnFilePath(rawPath: string, cwd?: string): string {
	let p = rawPath.trim();
	if (p.startsWith("file://")) {
		try {
			p = decodeURIComponent(new URL(p).pathname);
		} catch {
			p = p.slice("file://".length);
		}
	}
	p = p.replace(/\\/g, "/");
	if (cwd) {
		const normCwd = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
		if (normCwd && p.startsWith(`${normCwd}/`)) p = p.slice(normCwd.length + 1);
	}
	while (p.startsWith("./")) p = p.slice(2);
	return p || rawPath.trim();
}

function extractPathsFromArgs(args: unknown): string[] {
	const o = asObj(args);
	for (const k of PATH_ARG_KEYS) {
		const v = o[k];
		if (typeof v === "string" && v.trim()) return [v.trim()];
	}
	if (typeof o.input === "string") {
		const out: string[] = [];
		for (const line of o.input.split("\n")) {
			const m = HASHLINE_HEADER_RE.exec(line.trim());
			if (m && !out.includes(m[1])) out.push(m[1]);
		}
		return out;
	}
	return [];
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

const HEADER_PREFIXES = [
	"diff --git",
	"index ",
	"new file mode",
	"deleted file mode",
	"old mode",
	"new mode",
	"similarity index",
	"rename from",
	"rename to",
	"Binary files",
	"--- ",
	"+++ ",
	"\\ ",
];

interface HunkState {
	inHunk: boolean;
	oldRem: number;
	newRem: number;
}

function advanceHunkState(state: HunkState, line: string): "reset" | "hunk_header" | "hunk_body" | "outside" {
	if (line.startsWith("diff --git ")) {
		state.inHunk = false;
		state.oldRem = 0;
		state.newRem = 0;
		return "reset";
	}
	const mHunk = HUNK_HEADER_RE.exec(line);
	if (mHunk) {
		state.oldRem = mHunk[2] !== undefined ? Number(mHunk[2]) : 1;
		state.newRem = mHunk[4] !== undefined ? Number(mHunk[4]) : 1;
		state.inHunk = state.oldRem > 0 || state.newRem > 0;
		return "hunk_header";
	}
	if (line.startsWith("@@")) {
		state.inHunk = true;
		state.oldRem = Number.POSITIVE_INFINITY;
		state.newRem = Number.POSITIVE_INFINITY;
		return "hunk_header";
	}
	if (!state.inHunk) return "outside";
	if (!line.startsWith("\\ ")) {
		if (line.startsWith("+")) state.newRem--;
		else if (line.startsWith("-")) state.oldRem--;
		else if (line.startsWith(" ") || line === "") {
			state.oldRem--;
			state.newRem--;
		}
		if (state.oldRem <= 0 && state.newRem <= 0) state.inHunk = false;
	}
	return "hunk_body";
}

/** Count added/removed lines while distinguishing `@@ ... @@` hunk bodies from file headers. */
function countDiff(diff: string): { adds: number; dels: number; hasCounts: boolean } {
	let adds = 0;
	let dels = 0;
	let sawDiffLine = false;
	const state: HunkState = { inHunk: false, oldRem: 0, newRem: 0 };

	for (const line of diff.split("\n")) {
		const pos = advanceHunkState(state, line);
		if (pos === "reset" || pos === "hunk_header") continue;
		if (pos === "outside" && HEADER_PREFIXES.some((p) => line.startsWith(p))) continue;
		if (pos === "hunk_body" && line.startsWith("\\ ")) continue;
		if (line.startsWith("+")) {
			adds++;
			sawDiffLine = true;
		} else if (line.startsWith("-")) {
			dels++;
			sawDiffLine = true;
		}
	}
	return { adds, dels, hasCounts: sawDiffLine };
}

function synthesizeAddedDiff(path: string, content: string): string {
	if (!content) return "";
	const raw = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
	return [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${raw.length} @@`, ...raw.map((l) => `+${l}`)].join("\n");
}

function synthesizeReplaceDiff(path: string, oldText: string, newText: string): string {
	const oldLines = oldText === "" ? [] : (oldText.endsWith("\n") ? oldText.slice(0, -1) : oldText).split("\n");
	const newLines = newText === "" ? [] : (newText.endsWith("\n") ? newText.slice(0, -1) : newText).split("\n");
	return [
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -1,${oldLines.length} +1,${newLines.length} @@`,
		...oldLines.map((l) => `-${l}`),
		...newLines.map((l) => `+${l}`),
	].join("\n");
}

function splitHashlineInput(input: string): Array<{ path: string; diff: string; status: TurnDiffStatus }> {
	const lines = input.split("\n");
	const sections: Array<{ path: string; lines: string[]; status: TurnDiffStatus }> = [];
	for (const line of lines) {
		const m = HASHLINE_HEADER_RE.exec(line.trim());
		if (m) {
			sections.push({ path: m[1], lines: [], status: "M" });
			continue;
		}
		const cur = sections[sections.length - 1];
		if (!cur) continue;
		const trimmed = line.trim();
		if (trimmed === "REM") cur.status = "D";
		else if (line.startsWith("+")) cur.lines.push(line);
	}
	return sections.map((s) => ({
		path: s.path,
		status: s.status,
		diff:
			s.lines.length > 0
				? [`--- a/${s.path}`, `+++ b/${s.path}`, `@@ -1,0 +1,${s.lines.length} @@`, ...s.lines].join("\n")
				: "",
	}));
}

interface DiffSection {
	rawPath: string;
	diff: string;
	added: boolean;
	deleted: boolean;
	hasHeader: boolean;
}

function stripDiffPathPrefix(raw: string, prefix: "a/" | "b/"): string {
	const trimmed = raw.trim();
	return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function splitUnifiedHeaderSections(lines: readonly string[]): DiffSection[] {
	const headers: Array<{ start: number; rawPath: string; added: boolean; deleted: boolean }> = [];
	const state: HunkState = { inHunk: false, oldRem: 0, newRem: 0 };
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (advanceHunkState(state, line) !== "outside") continue;
		const next = lines[i + 1];
		if (line.startsWith("--- ") && next?.startsWith("+++ ")) {
			const added = line === "--- /dev/null";
			const deleted = next === "+++ /dev/null";
			const rawPath = !deleted
				? stripDiffPathPrefix(next.slice(4), "b/")
				: !added
					? stripDiffPathPrefix(line.slice(4), "a/")
					: "";
			headers.push({ start: i, rawPath, added, deleted });
			i++;
		}
	}
	const out: DiffSection[] = [];
	for (let i = 0; i < headers.length; i++) {
		const cur = headers[i];
		const end = i + 1 < headers.length ? headers[i + 1].start : lines.length;
		if (!cur.rawPath) continue;
		out.push({
			rawPath: cur.rawPath,
			diff: lines.slice(cur.start, end).join("\n"),
			added: cur.added,
			deleted: cur.deleted,
			hasHeader: true,
		});
	}
	return out;
}

function splitDiffByFile(diff: string, fallbackPaths: readonly string[]): DiffSection[] {
	const lines = diff.split("\n");
	const sections: Array<{ start: number; path: string | null; added: boolean; deleted: boolean }> = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("diff --git ")) {
			const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
			sections.push({ start: i, path: m ? m[2] : null, added: false, deleted: false });
			continue;
		}
		const cur = sections[sections.length - 1];
		if (cur) {
			if (line.startsWith("new file mode ") || line === "--- /dev/null") cur.added = true;
			if (line.startsWith("deleted file mode ") || line === "+++ /dev/null") cur.deleted = true;
		}
	}
	if (sections.length > 0) {
		const out: DiffSection[] = [];
		for (let i = 0; i < sections.length; i++) {
			const cur = sections[i];
			const end = i + 1 < sections.length ? sections[i + 1].start : lines.length;
			const rawPath = cur.path ?? (fallbackPaths.length === 1 ? fallbackPaths[0] : fallbackPaths[i] ?? "");
			if (!rawPath) continue;
			out.push({
				rawPath,
				diff: lines.slice(cur.start, end).join("\n"),
				added: cur.added,
				deleted: cur.deleted,
				hasHeader: true,
			});
		}
		if (out.length > 0) return out;
	}
	const unified = splitUnifiedHeaderSections(lines);
	if (unified.length > 0) return unified;
	// Never assign an unsectioned multi-file patch to the first file.
	if (fallbackPaths.length !== 1) return [];
	return [{ rawPath: fallbackPaths[0], diff, added: false, deleted: false, hasHeader: false }];
}

function looksLikePrivateDiff(text: string): boolean {
	return /^[+-]\d*\|/m.test(text);
}

export function collectMobileTurnDiffSummary(steps: readonly Step[], cwd?: string): TurnDiffSummary {
	interface MutableEntry {
		path: string;
		status: TurnDiffStatus;
		adds: number;
		dels: number;
		chunks: string[];
		hasCounts: boolean;
	}
	const byPath = new Map<string, MutableEntry>();
	const mergeStatus = (prev: TurnDiffStatus, next: TurnDiffStatus): TurnDiffStatus => {
		if (prev === next) return prev;
		if (prev === "A") return next === "D" ? "D" : "A";
		if (prev === "M") return next === "D" ? "D" : "M";
		return "M";
	};
	const diffShowsExistingFile = (diff: string): boolean => {
		for (const line of diff.split("\n")) {
			if (line.startsWith("--- ") && line !== "--- /dev/null") return true;
			if (/^-\d*\|/.test(line) || /^ \d*\|/.test(line)) return true;
		}
		return false;
	};
	const ensure = (rawPath: string, status: TurnDiffStatus): MutableEntry => {
		const path = normalizeTurnFilePath(rawPath, cwd);
		const existing = byPath.get(path);
		if (existing) {
			existing.status = mergeStatus(existing.status, status);
			return existing;
		}
		const created: MutableEntry = { path, status, adds: 0, dels: 0, chunks: [], hasCounts: false };
		byPath.set(path, created);
		return created;
	};

	for (const step of steps) {
		if (step.kind !== "tool") continue;
		const { tool } = step;
		if (tool.status === "error" || tool.status === "running") continue;
		const name = tool.name.toLowerCase();
		const toolDiff = typeof tool.diff === "string" && tool.diff.trim().length > 0 ? tool.diff : null;
		if (!EDIT_TOOLS.has(name) && !toolDiff) continue;

		const argsObj = asObj(tool.args);
		const rawPaths = extractPathsFromArgs(tool.args);
		const resultDiff =
			tool.result && (looksLikeDiff(tool.result) || looksLikePrivateDiff(tool.result)) ? tool.result : null;
		const argPatch =
			typeof argsObj.patch === "string" && looksLikeDiff(argsObj.patch)
				? argsObj.patch
				: typeof argsObj.diff === "string" && looksLikeDiff(argsObj.diff)
					? argsObj.diff
					: null;
		const rawDiff = toolDiff ?? resultDiff ?? argPatch;

		if (rawDiff) {
			const sections = splitDiffByFile(rawDiff, rawPaths);
			if (sections.length > 0) {
				const covered = new Set<string>();
				for (const sec of sections) {
					const counts = countDiff(sec.diff);
					const st: TurnDiffStatus = sec.deleted
						? "D"
						: sec.added
							? "A"
							: WRITE_TOOLS.has(name) && !sec.hasHeader && counts.dels === 0 && !diffShowsExistingFile(sec.diff)
								? "A"
								: "M";
					const entry = ensure(sec.rawPath, st);
					covered.add(entry.path);
					entry.adds += counts.adds;
					entry.dels += counts.dels;
					if (counts.hasCounts) entry.hasCounts = true;
					entry.chunks.push(sec.diff);
				}
				for (const p of rawPaths) {
					const norm = normalizeTurnFilePath(p, cwd);
					if (!covered.has(norm)) ensure(p, WRITE_TOOLS.has(name) ? "A" : "M");
				}
				continue;
			}
			if (typeof argsObj.input !== "string") {
				for (const p of rawPaths) ensure(p, WRITE_TOOLS.has(name) ? "A" : "M");
				continue;
			}
		}

		if (WRITE_TOOLS.has(name) && rawPaths.length > 0) {
			const entry = ensure(rawPaths[0], "A");
			if (entry.status === "A" && typeof argsObj.content === "string") {
				const synth = synthesizeAddedDiff(entry.path, argsObj.content);
				if (synth) {
					const counts = countDiff(synth);
					entry.adds += counts.adds;
					entry.dels += counts.dels;
					entry.hasCounts = true;
					entry.chunks.push(synth);
				} else {
					entry.hasCounts = true;
				}
			}
			continue;
		}

		if (typeof argsObj.input === "string") {
			for (const sec of splitHashlineInput(argsObj.input)) {
				const entry = ensure(sec.path, sec.status);
				if (sec.diff) {
					const counts = countDiff(sec.diff);
					entry.adds += counts.adds;
					entry.dels += counts.dels;
					if (counts.hasCounts) entry.hasCounts = true;
					entry.chunks.push(sec.diff);
				}
			}
			continue;
		}

		const oldText =
			typeof argsObj.oldText === "string"
				? argsObj.oldText
				: typeof argsObj.old_string === "string"
					? argsObj.old_string
					: null;
		const newText =
			typeof argsObj.newText === "string"
				? argsObj.newText
				: typeof argsObj.new_string === "string"
					? argsObj.new_string
					: null;
		if (rawPaths.length > 0 && oldText !== null && newText !== null) {
			const entry = ensure(rawPaths[0], "M");
			const synth = synthesizeReplaceDiff(entry.path, oldText, newText);
			const counts = countDiff(synth);
			entry.adds += counts.adds;
			entry.dels += counts.dels;
			entry.hasCounts = counts.hasCounts;
			entry.chunks.push(synth);
			continue;
		}

		for (const p of rawPaths) ensure(p, WRITE_TOOLS.has(name) ? "A" : "M");
	}

	const files: TurnDiffFileEntry[] = [];
	let totalAdds = 0;
	let totalDels = 0;
	let hasAnyCounts = false;
	for (const entry of byPath.values()) {
		if (entry.hasCounts) {
			totalAdds += entry.adds;
			totalDels += entry.dels;
			hasAnyCounts = true;
		}
		files.push({
			path: entry.path,
			status: entry.status,
			adds: entry.adds,
			dels: entry.dels,
			diff: entry.chunks.length > 0 ? entry.chunks.join("\n") : null,
			hasCounts: entry.hasCounts,
		});
	}

	return { files, totalAdds, totalDels, hasAnyCounts };
}

/**
 * Desktop-parity Turn Diff summary card rendered below an assistant reply
 * whenever files were modified, added, or deleted in the turn.
 */
export const TurnDiffCard = memo(function TurnDiffCard({
	steps,
	cwd,
}: {
	steps: readonly Step[];
	cwd?: string;
}) {
	const summary = useMemo(() => collectMobileTurnDiffSummary(steps, cwd), [steps, cwd]);
	const [open, setOpen] = useState(false);
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());

	if (summary.files.length === 0) return null;

	const allExpanded =
		summary.files.length > 0 && summary.files.every((f) => expandedPaths.has(f.path));

	const toggleCard = () => {
		const nextOpen = !open;
		setOpen(nextOpen);
		if (nextOpen && summary.files.length === 1 && expandedPaths.size === 0) {
			setExpandedPaths(new Set([summary.files[0].path]));
		}
	};

	const toggleFile = (path: string) => {
		setExpandedPaths((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	};

	const toggleExpandAll = () => {
		setExpandedPaths(allExpanded ? new Set() : new Set(summary.files.map((f) => f.path)));
	};

	return (
		<div
			className="mt-3 overflow-hidden rounded-xl border border-m-border bg-m-card shadow-m-card"
			data-no-longpress
		>
			<button
				type="button"
				onClick={toggleCard}
				aria-expanded={open}
				className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left transition-colors active:bg-m-surface-hover"
			>
				<FileDiff size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-m-text-quiet" />
				<span className="truncate whitespace-nowrap text-[13px] font-medium text-m-text-2">
					修改了 {summary.files.length} 个文件
				</span>
				{summary.hasAnyCounts && (
					<span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-m-mono text-[11px] tabular-nums">
						<span className="text-m-success">+{summary.totalAdds}</span>
						<span className="text-m-danger">−{summary.totalDels}</span>
					</span>
				)}
				<ChevronRight
					size={14}
					strokeWidth={1.75}
					aria-hidden
					className={`ml-auto shrink-0 text-m-text-quiet transition-transform duration-150 ${
						open ? "rotate-90" : ""
					}`}
				/>
			</button>

			{open && (
				<div className="divide-y divide-m-border border-t border-m-border">
					{summary.files.length > 1 && (
						<div className="flex items-center justify-end bg-m-surface/40 px-3 py-1">
							<button
								type="button"
								onClick={toggleExpandAll}
								className="whitespace-nowrap rounded-full border border-m-border px-2.5 py-0.5 text-[11px] font-medium text-m-text-2 active:bg-m-surface-hover"
							>
								{allExpanded ? "全部收起" : "全部展开"}
							</button>
						</div>
					)}
					{summary.files.map((f) => {
						const fileOpen = expandedPaths.has(f.path);
						return (
							<div key={f.path} className="flex flex-col">
								<button
									type="button"
									onClick={() => toggleFile(f.path)}
									aria-expanded={fileOpen}
									className="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left transition-colors active:bg-m-surface-hover"
								>
									<ChevronRight
										size={12}
										strokeWidth={1.75}
										aria-hidden
										className={`shrink-0 text-m-text-faint transition-transform duration-150 ${
											fileOpen ? "rotate-90" : ""
										}`}
									/>
									<span
										className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 font-m-mono text-[10px] font-semibold leading-none ${STATUS_CHIP_STYLE[f.status]}`}
										title={STATUS_TITLE[f.status]}
									>
										{f.status}
									</span>
									<span className="min-w-0 flex-1 break-all font-m-mono text-[12px] leading-5 text-m-text">
										{f.path}
									</span>
									{f.hasCounts && (
										<span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-m-mono text-[11px] tabular-nums">
											<span className="text-m-success">+{f.adds}</span>
											<span className="text-m-danger">−{f.dels}</span>
										</span>
									)}
								</button>

								{fileOpen && (
									<div className="border-t border-m-border bg-m-bg-elev/60 px-3 py-2.5">
										{f.diff && f.diff.trim().length > 0 ? (
											<DiffView diff={f.diff} />
										) : (
											<p className="text-[12px] text-m-text-quiet">暂无内联差异预览</p>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
});
