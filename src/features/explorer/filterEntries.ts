import type { DirEntry } from "../../lib/contracts";
import { isInside, trimTrailingSlash } from "../../lib/paths";

/**
 * Dependency and build directories hidden by default in the file tree.
 * Mirrors the non-dot directory skip list in `list_workspace_files`.
 */
const IGNORED_DIRS: Record<string, true> = {
	node_modules: true,
	target: true,
	dist: true,
	build: true,
	out: true,
	coverage: true,
	__pycache__: true,
	venv: true,
	vendor: true,
	Pods: true,
};

/** Returns true when an entry is a dotfile/dot-dir or a common build/dependency directory. */
export function isHiddenOrIgnoredEntry(entry: DirEntry): boolean {
	if (entry.name.startsWith(".")) return true;
	return entry.isDir && entry.name in IGNORED_DIRS;
}

/**
 * Collects paths that should bypass the hidden filter (selected or expanded paths
 * plus their ancestor directories up to `rootPath`), so explicitly revealed hidden
 * files or directories never vanish from the tree.
 */
export function collectForceVisiblePaths(
	rootPath: string | null,
	selectedPath: string | null,
	expandedPaths: ReadonlySet<string>,
): Set<string> {
	const visible = new Set<string>();
	const root = rootPath ? (trimTrailingSlash(rootPath) || "/") : null;

	const addWithAncestors = (raw: string | null) => {
		if (!raw) return;
		const normalized = trimTrailingSlash(raw) || "/";
		visible.add(normalized);
		if (!root || !isInside(normalized, root) || normalized === root) return;
		const rel = root === "/" ? normalized.slice(1) : normalized.slice(root.length + 1);
		const segments = rel.split("/").filter(Boolean);
		let acc = root;
		for (const seg of segments) {
			acc = acc === "/" ? `/${seg}` : `${acc}/${seg}`;
			visible.add(acc);
		}
	};

	addWithAncestors(selectedPath);
	for (const p of expandedPaths) addWithAncestors(p);
	return visible;
}

export function filterVisibleEntries(
	entries: DirEntry[],
	showHidden: boolean,
	forceVisiblePaths?: ReadonlySet<string>,
): DirEntry[] {
	if (showHidden) return entries;
	return entries.filter(
		(entry) => !isHiddenOrIgnoredEntry(entry) || Boolean(forceVisiblePaths?.has(entry.path)),
	);
}
