/**
 * Conversation-tree helpers for the mobile chat: walk parent pointers across
 * normalized `Item` rows plus raw/tree parent maps (`parentById` and `get_tree`),
 * and fall back safely when a parent chain is incomplete.
 */
import type { Item } from "../../../core/types";

const hasOwn = Object.prototype.hasOwnProperty;

/** Version group of one entry among its same-kind siblings (file order). */
export interface TreeVersions {
	/** 0-based position of the current entry among `ids`. */
	index: number;
	/** Sibling count including the current entry. */
	total: number;
	/** Sibling entry ids, the current one included. */
	ids: string[];
}

/**
 * Walk an upstream `get_tree` response (`{ tree: [...] }` with `{ entry, children }` or
 * `{ id, parentId, children }` nodes, or flat `{ entries: [...] }`) into an `id -> parentId`
 * map covering all nodes including hidden metadata and tool results.
 */
export function extractTreeParents(tree: unknown): Record<string, string | null> {
	const parents: Record<string, string | null> = {};
	if (!tree || typeof tree !== "object") return parents;

	const stack: Array<{ node: unknown; fallbackParentId: string | null }> = [];
	const pushList = (list: readonly unknown[], fallbackParentId: string | null) => {
		for (let i = list.length - 1; i >= 0; i--) {
			stack.push({ node: list[i], fallbackParentId });
		}
	};

	if (Array.isArray(tree)) {
		pushList(tree, null);
	} else {
		const obj = tree as Record<string, unknown>;
		if (Array.isArray(obj.tree)) pushList(obj.tree, null);
		if (Array.isArray(obj.entries)) pushList(obj.entries, null);
		if (!Array.isArray(obj.tree) && !Array.isArray(obj.entries)) {
			stack.push({ node: obj, fallbackParentId: null });
		}
	}

	const seen = new Set<object>();
	while (stack.length > 0) {
		const { node, fallbackParentId } = stack.pop()!;
		if (!node || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		const rec = node as Record<string, unknown>;
		const entry = rec.entry && typeof rec.entry === "object" ? (rec.entry as Record<string, unknown>) : rec;
		const id = typeof entry.id === "string" && entry.id ? entry.id : null;
		if (id) {
			if (typeof entry.parentId === "string") {
				parents[id] = entry.parentId;
			} else if (entry.parentId === null) {
				parents[id] = null;
			} else if (!(id in parents)) {
				parents[id] = fallbackParentId;
			}
		}
		if (Array.isArray(rec.children)) {
			pushList(rec.children, id ?? fallbackParentId);
		}
	}
	return parents;
}

interface LeafWalk {
	path: Set<string>;
	/** True when the walk terminated cleanly at root (`null`) or a cycle; false if an ancestor is missing. */
	complete: boolean;
}

function walkLeafPath(
	items: readonly { id: string; parentId?: string | null }[],
	leafId: string | null,
	extraParents?: Readonly<Record<string, string | null>>,
): LeafWalk {
	const path = new Set<string>();
	if (!leafId) return { path, complete: false };

	const byId = new Map(items.map((it) => [it.id, it]));
	const maxSteps = items.length + (extraParents ? Object.keys(extraParents).length : 0);

	let cur: string | null = leafId;
	for (let i = 0; cur !== null && i <= maxSteps; i++) {
		if (path.has(cur)) return { path, complete: true };
		const item = byId.get(cur);
		const inExtra = extraParents != null && hasOwn.call(extraParents, cur);
		if (!item && !inExtra) {
			return { path, complete: false };
		}
		path.add(cur);
		if (item && item.parentId != null) {
			cur = item.parentId;
		} else if (inExtra) {
			cur = extraParents[cur] ?? null;
		} else {
			cur = item?.parentId ?? null;
		}
	}
	return { path, complete: cur === null };
}

/** Ids on the root→leaf path (the leaf included). */
export function leafPathIds(
	items: readonly { id: string; parentId?: string | null }[],
	leafId: string | null,
	extraParents?: Readonly<Record<string, string | null>>,
): Set<string> {
	return walkLeafPath(items, leafId, extraParents).path;
}

/**
 * Keep only the entries on the root→leaf path, in file order. `leafId` null
 * or a broken parent chain (missing ancestor in both `items` and `extraParents`)
 * returns `items` unchanged so earlier messages are never silently dropped.
 */
export function filterToLeafPath<T extends { id: string; parentId?: string | null }>(
	items: readonly T[],
	leafId: string | null,
	extraParents?: Readonly<Record<string, string | null>>,
): T[] {
	if (!leafId) return items as T[];
	const { path, complete } = walkLeafPath(items, leafId, extraParents);
	if (!complete) return items as T[];
	return items.filter((it) => path.has(it.id));
}

/**
 * Sibling versions of `entryId`: rows sharing its parent and kind. The
 * current one is the sibling on the leaf path; null when there are no
 * siblings or none is on the path (rewound past the entry).
 */
export function treeVersions(
	items: readonly Item[],
	leafId: string | null,
	entryId: string,
	extraParents?: Readonly<Record<string, string | null>>,
): TreeVersions | null {
	const self = items.find((it) => it.id === entryId);
	if (!self) return null;
	const siblings = items.filter(
		(it) => it.kind === self.kind && it.parentId === self.parentId,
	);
	if (siblings.length < 2) return null;
	const path = leafPathIds(items, leafId, extraParents);
	const index = siblings.findIndex((it) => it.id === entryId);
	if (index < 0 || !path.has(entryId)) return null;
	return { index, total: siblings.length, ids: siblings.map((it) => it.id) };
}
