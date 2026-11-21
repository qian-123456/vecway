/**
 * File-explorer workspace override (§10). Cross-feature entry point: other
 * panels (e.g. the Git worktree graph) can pin which directory the explorer
 * shows without touching session/center state.
 */
import { create } from "zustand";
import { useUi } from "./ui";

/** Normalize a directory path by collapsing `//`, `.`, `..`, and trailing slashes (except `/`). */
function normalizeDirPath(p: string): string {
	const lead = p.startsWith("/") ? "/" : "";
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") {
				out.pop();
			} else if (!lead) {
				out.push("..");
			}
			continue;
		}
		out.push(seg);
	}
	return lead + out.join("/") || (lead ? "/" : p);
}

export const useExplorer = create<{
	/** Manually pinned workspace id; null = auto-follow the active session. */
	workspaceId: string | null;
	/** Temporary directory root when opening a directory outside the active workspace. */
	customRootPath: string | null;
	/** Directory path queued to be expanded and revealed in the file explorer. */
	pendingRevealPath: string | null;
	/** Monotonic counter so re-clicking the same directory triggers reveal again. */
	revealNonce: number;
	setWorkspaceId(id: string | null): void;
	openDirectory(dirPath: string): void;
	clearCustomRoot(): void;
	setCustomRootPath(path: string | null): void;
}>((set) => ({
	workspaceId: null,
	customRootPath: null,
	pendingRevealPath: null,
	revealNonce: 0,
	setWorkspaceId: (id) => set({ workspaceId: id, customRootPath: null }),
	openDirectory: (dirPath) => {
		const normalized = normalizeDirPath(dirPath);
		set((s) => ({
			pendingRevealPath: normalized,
			revealNonce: s.revealNonce + 1,
		}));
		useUi.getState().setRightTab("explorer");
	},
	clearCustomRoot: () => set({ customRootPath: null }),
	setCustomRootPath: (path) => set({ customRootPath: path ? normalizeDirPath(path) : null }),
}));
