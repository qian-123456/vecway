/** [B] Aggregates per-file diff statistics and unified/private diff chunks for
 * a single assistant turn from tool execution results and optional Git turn
 * checkpoints, so Codex-style TurnDiffCard renders synchronously on commit. */

import type { ToolResultInfo, TurnCheckpoint } from "../../lib/contracts";
import { diffCounts, parseDiff } from "./DiffView";
import type { StepShape } from "./ExecutionDisclosure";
import { toolFilePaths } from "./turnGrouping";

type TurnChangedFile = TurnCheckpoint["files"][number];
export type TurnDiffStatus = TurnChangedFile["status"];

export interface TurnDiffFileEntry {
	/** Workspace-relative path when inside `cwd`, else normalized path. */
	path: string;
	/** Original path best suited for `openFileLink`. */
	openPath: string;
	status: TurnDiffStatus;
	adds: number;
	dels: number;
	/** Combined diff string consumable by `DiffView`, or null when only Git status is known. */
	diff: string | null;
	/** True when `adds` / `dels` come from parsed diff lines rather than an unparsed status-only entry. */
	hasCounts: boolean;
}

export interface TurnDiffSummary {
	files: TurnDiffFileEntry[];
	totalAdds: number;
	totalDels: number;
	hasAnyCounts: boolean;
	undone: boolean;
}

const WRITE_TOOLS = new Set(["write", "write_file"]);
const EDIT_LIKE_TOOLS = new Set(["edit", "edit_file", "ast_edit", "write", "write_file", "apply_patch"]);

const asObj = (v: unknown): Record<string, unknown> =>
	typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/** Normalize a tool or Git path relative to `cwd` so both sources merge cleanly. */
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
		if (normCwd && p.startsWith(`${normCwd}/`)) {
			p = p.slice(normCwd.length + 1);
		}
	}
	while (p.startsWith("./")) p = p.slice(2);
	return p || rawPath.trim();
}

/** Synthesize private-format `+lineNo|text` diff for a newly written file. */
export function synthesizeAddedFileDiff(content: string): string {
	if (content === "") return "";
	const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
	return lines.map((line, i) => `+${i + 1}|${line}`).join("\n");
}

interface RawDiffSection {
	rawPath: string;
	diff: string;
	inferredAdded?: boolean;
	inferredDeleted?: boolean;
}

/**
 * Split a multi-file unified `diff --git` payload into per-file sections.
 * Falls back to associating `diff` with `fallbackPaths[0]` for OMP's single-file
 * private `+line|text` format.
 */
export function splitToolDiffByFile(
	diff: string,
	fallbackPaths: readonly string[],
): RawDiffSection[] {
	const lines = diff.split("\n");
	const sections: { start: number; path: string | null; added: boolean; deleted: boolean }[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("diff --git ")) {
			const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
			sections.push({
				start: i,
				path: m ? m[2] : null,
				added: false,
				deleted: false,
			});
			continue;
		}
		const cur = sections[sections.length - 1];
		if (cur) {
			if (line.startsWith("new file mode ") || line === "--- /dev/null") cur.added = true;
			if (line.startsWith("deleted file mode ") || line === "+++ /dev/null") cur.deleted = true;
		}
	}

	if (sections.length > 0) {
		const out: RawDiffSection[] = [];
		for (let i = 0; i < sections.length; i++) {
			const cur = sections[i];
			const end = i + 1 < sections.length ? sections[i + 1].start : lines.length;
			const rawPath = cur.path ?? fallbackPaths[i] ?? fallbackPaths[0] ?? "";
			if (!rawPath) continue;
			out.push({
				rawPath,
				diff: lines.slice(cur.start, end).join("\n"),
				inferredAdded: cur.added,
				inferredDeleted: cur.deleted,
			});
		}
		if (out.length > 0) return out;
	}

	if (fallbackPaths.length === 0) return [];
	return [{ rawPath: fallbackPaths[0], diff }];
}

/** Fast estimate check used by `blockEstimate` before rendering. */
export function hasTurnEditedFiles(steps: readonly { kind: string; call?: { name: string; args: unknown } }[]): boolean {
	for (const step of steps) {
		if (step.kind !== "tool" || !step.call) continue;
		if (EDIT_LIKE_TOOLS.has(step.call.name.toLowerCase()) && toolFilePaths(step.call.args).length > 0) {
			return true;
		}
	}
	return false;
}

/** Collect merged file changes for one turn in stable first-seen order. */
export function collectTurnDiffSummary({
	steps,
	toolResultsByCallId,
	liveTools,
	turnCheckpoint,
	cwd,
}: {
	steps: readonly StepShape[];
	toolResultsByCallId?: ReadonlyMap<string, ToolResultInfo>;
	liveTools?: Readonly<Record<string, { status?: string; details?: unknown }>>;
	turnCheckpoint?: TurnCheckpoint;
	cwd?: string;
}): TurnDiffSummary {
	const checkpointMap = new Map<string, TurnChangedFile>();
	if (turnCheckpoint) {
		for (const cf of turnCheckpoint.files) {
			checkpointMap.set(normalizeTurnFilePath(cf.path, cwd), cf);
		}
	}

	interface MutableEntry {
		path: string;
		openPath: string;
		status: TurnDiffStatus;
		adds: number;
		dels: number;
		chunks: string[];
		hasCounts: boolean;
		writeFallbackContent: string | null;
	}

	const byPath = new Map<string, MutableEntry>();
	const ensure = (rawPath: string, initialStatus: TurnDiffStatus): MutableEntry => {
		const path = normalizeTurnFilePath(rawPath, cwd);
		const existing = byPath.get(path);
		if (existing) return existing;
		const created: MutableEntry = {
			path,
			openPath: rawPath.trim() || path,
			status: initialStatus,
			adds: 0,
			dels: 0,
			chunks: [],
			hasCounts: false,
			writeFallbackContent: null,
		};
		byPath.set(path, created);
		return created;
	};

	for (const step of steps) {
		if (step.kind !== "tool") continue;
		const res = step.result ?? toolResultsByCallId?.get(step.call.id);
		const live = liveTools?.[step.call.id];
		if (res?.isError || live?.status === "error" || live?.status === "running") continue;

		const toolName = step.call.name.toLowerCase();
		const det = asObj(res?.details ?? live?.details);
		const rawDiff = typeof det.diff === "string" && det.diff.trim().length > 0 ? det.diff : null;
		const rawPaths = toolFilePaths(step.call.args);

		if (rawDiff !== null) {
			const fallbackPaths = rawPaths.length > 0 ? rawPaths : [step.call.name];
			const sections = splitToolDiffByFile(rawDiff, fallbackPaths);
			const covered = new Set<string>();
			for (const sec of sections) {
				const initialStatus: TurnDiffStatus = sec.inferredDeleted
					? "D"
					: sec.inferredAdded || WRITE_TOOLS.has(toolName)
						? "A"
						: "M";
				const entry = ensure(sec.rawPath, initialStatus);
				covered.add(entry.path);
				const counts = diffCounts(parseDiff(sec.diff));
				entry.adds += counts.adds;
				entry.dels += counts.dels;
				entry.chunks.push(sec.diff);
				entry.hasCounts = true;
			}
			// Multi-file tool call whose diff did not split cleanly still lists remaining target files.
			if (EDIT_LIKE_TOOLS.has(toolName)) {
				for (const extra of rawPaths) {
					const norm = normalizeTurnFilePath(extra, cwd);
					if (!covered.has(norm)) {
						ensure(extra, WRITE_TOOLS.has(toolName) ? "A" : "M");
					}
				}
			}
			continue;
		}

		// `write` / `write_file` without `details.diff` (e.g. creating a brand-new file).
		if (WRITE_TOOLS.has(toolName) && rawPaths.length > 0 && (res !== undefined || live?.status === "done" || step.item !== undefined)) {
			const content = asObj(step.call.args).content;
			const entry = ensure(rawPaths[0], "A");
			if (typeof content === "string") {
				entry.writeFallbackContent = content;
			}
		}
	}

	// Merge Git checkpoint ground truth (`A` / `M` / `D` and bash-modified files).
	if (turnCheckpoint) {
		for (const [normPath, cf] of checkpointMap) {
			const existing = byPath.get(normPath);
			if (existing) {
				existing.status = cf.status;
			} else {
				ensure(cf.path, cf.status);
			}
		}
	}

	const files: TurnDiffFileEntry[] = [];
	let totalAdds = 0;
	let totalDels = 0;
	let hasAnyCounts = false;

	for (const entry of byPath.values()) {
		// Synthesize added lines for `write` only when creating a file (`A`) or when no checkpoint exists.
		// Overwriting an existing file (`M`) without a tool diff leaves `diff = null` so `gitDiff` can load true +/- counts.
		if (entry.chunks.length === 0 && entry.writeFallbackContent !== null && entry.status === "A") {
			const synth = synthesizeAddedFileDiff(entry.writeFallbackContent);
			if (synth) {
				const counts = diffCounts(parseDiff(synth));
				entry.adds = counts.adds;
				entry.dels = counts.dels;
				entry.chunks.push(synth);
				entry.hasCounts = true;
			} else {
				entry.hasCounts = true;
			}
		}

		const diff = entry.chunks.length > 0 ? entry.chunks.join("\n") : null;
		if (entry.hasCounts) {
			totalAdds += entry.adds;
			totalDels += entry.dels;
			hasAnyCounts = true;
		}
		files.push({
			path: entry.path,
			openPath: entry.openPath,
			status: entry.status,
			adds: entry.adds,
			dels: entry.dels,
			diff,
			hasCounts: entry.hasCounts,
		});
	}

	return {
		files,
		totalAdds,
		totalDels,
		hasAnyCounts,
		undone: Boolean(turnCheckpoint?.undone),
	};
}
