/**
 * Zustand store for SessionSidebar view state.
 * Survives sidebar collapse/unmount (Cmd+B) and persists user choices.
 */

import { create } from "zustand";
import type { SessionMeta, SpaceMode, Workspace } from "../../lib/contracts";
import { sessionDisplayName } from "../../lib/sessionName";
import { isSpaceMode } from "./modes";

export const ACTIVE_MODE_KEY = "ompws:active-space-mode";
export const COLLAPSED_GROUPS_KEY = "ompws:collapsed-groups";
export const DISPLAY_PREFS_KEY = "ompws:sidebar-display-prefs";

export type SidebarStatusFilter = "all" | "attention" | "running" | "unread";
export type SidebarTimeFilter = "all" | "today" | "7days" | "30days";
export type SidebarGroupBy = "project" | "worktree" | "none";
export type SidebarSessionSort = "updated" | "created" | "title";
export type SidebarProjectSort = "custom" | "updated" | "name";

interface PersistedDisplayPrefs {
	groupBy: SidebarGroupBy;
	sessionSort: SidebarSessionSort;
	projectSort: SidebarProjectSort;
	autoPin: boolean;
	hideEmptyProjects: boolean;
	showUnassigned: boolean;
}

const DEFAULT_DISPLAY_PREFS: PersistedDisplayPrefs = {
	groupBy: "worktree",
	sessionSort: "updated",
	projectSort: "custom",
	autoPin: false,
	hideEmptyProjects: false,
	showUnassigned: true,
};

function isGroupBy(v: unknown): v is SidebarGroupBy {
	return v === "project" || v === "worktree" || v === "none";
}

function isSessionSort(v: unknown): v is SidebarSessionSort {
	return v === "updated" || v === "created" || v === "title";
}

function isProjectSort(v: unknown): v is SidebarProjectSort {
	return v === "custom" || v === "updated" || v === "name";
}

export function readDisplayPrefs(): PersistedDisplayPrefs {
	try {
		const raw = localStorage.getItem(DISPLAY_PREFS_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const rec = parsed as Record<string, unknown>;
				return {
					groupBy: isGroupBy(rec.groupBy) ? rec.groupBy : DEFAULT_DISPLAY_PREFS.groupBy,
					sessionSort: isSessionSort(rec.sessionSort)
						? rec.sessionSort
						: DEFAULT_DISPLAY_PREFS.sessionSort,
					projectSort: isProjectSort(rec.projectSort)
						? rec.projectSort
						: DEFAULT_DISPLAY_PREFS.projectSort,
					autoPin:
						typeof rec.autoPin === "boolean" ? rec.autoPin : DEFAULT_DISPLAY_PREFS.autoPin,
					hideEmptyProjects:
						typeof rec.hideEmptyProjects === "boolean"
							? rec.hideEmptyProjects
							: DEFAULT_DISPLAY_PREFS.hideEmptyProjects,
					showUnassigned:
						typeof rec.showUnassigned === "boolean"
							? rec.showUnassigned
							: DEFAULT_DISPLAY_PREFS.showUnassigned,
				};
			}
		}
	} catch {
		/* ignore malformed prefs */
	}
	return { ...DEFAULT_DISPLAY_PREFS };
}

export function writeDisplayPrefs(prefs: PersistedDisplayPrefs): void {
	try {
		localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify(prefs));
	} catch {
		/* ignore storage quota or private mode */
	}
}

export function readActiveMode(): SpaceMode {
	try {
		const raw = localStorage.getItem(ACTIVE_MODE_KEY);
		return isSpaceMode(raw) ? raw : "code";
	} catch {
		return "code";
	}
}

export function writeActiveMode(mode: SpaceMode): void {
	try {
		localStorage.setItem(ACTIVE_MODE_KEY, mode);
	} catch {
		/* ignore storage quota or private mode */
	}
}

export function readCollapsedGroups(): Record<string, boolean> {
	try {
		const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				return parsed;
			}
		}
	} catch {
		/* ignore malformed json */
	}
	return {
		__unassigned: false,
		__deleted: false,
	};
}

export function writeCollapsedGroups(state: Record<string, boolean>): void {
	try {
		localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(state));
	} catch {
		/* ignore */
	}
}

export interface SidebarState {
	/** Active space mode: the whole sidebar shows only this mode's data. */
	activeMode: SpaceMode;
	setActiveMode: (mode: SpaceMode) => void;

	/** Explicit user expand/collapse toggles for workspace and special groups */
	groupOpen: Record<string, boolean>;
	setGroupOpen: (
		update:
			| Record<string, boolean>
			| ((prev: Record<string, boolean>) => Record<string, boolean>),
	) => void;
	toggleGroup: (key: string, defaultOpen?: boolean) => void;
	isGroupOpen: (key: string, defaultOpen?: boolean) => boolean;

	/** Whether archived sessions are included in grouping */
	showArchived: boolean;
	setShowArchived: (show: boolean) => void;
	toggleShowArchived: () => void;

	/** Display Options (group, sort, filter, display flags) */
	groupBy: SidebarGroupBy;
	setGroupBy: (groupBy: SidebarGroupBy) => void;
	sessionSort: SidebarSessionSort;
	setSessionSort: (sessionSort: SidebarSessionSort) => void;
	projectSort: SidebarProjectSort;
	setProjectSort: (projectSort: SidebarProjectSort) => void;
	autoPin: boolean;
	setAutoPin: (autoPin: boolean) => void;
	archivedOnly: boolean;
	setArchivedOnly: (archivedOnly: boolean) => void;
	showUnassigned: boolean;
	setShowUnassigned: (showUnassigned: boolean) => void;

	/** Project-bar filter controls */
	filterQuery: string;
	setFilterQuery: (query: string) => void;
	statusFilter: SidebarStatusFilter;
	setStatusFilter: (status: SidebarStatusFilter) => void;
	timeFilter: SidebarTimeFilter;
	setTimeFilter: (time: SidebarTimeFilter) => void;
	hideEmptyProjects: boolean;
	setHideEmptyProjects: (hide: boolean) => void;
	resetSidebarFilters: () => void;

	/**
	 * Per-section disclosure state:
	 * - `…|more`: how many top-level session rows to render (default 3)
	 * - `…|sub`: 0/1 open flag for worktree/branch subgroups
	 */
	expandedSections: Record<string, number>;
	setExpandedSections: (
		update:
			| Record<string, number>
			| ((prev: Record<string, number>) => Record<string, number>),
	) => void;
	/** S5: store an explicit open flag (1 = open, 0 = collapsed) */
	toggleSection: (key: string, defaultOpen?: boolean) => void;
	setSectionCount: (key: string, count: number) => void;

	/** S16: in-flight creation key formatted as `${ws.id}|${cwd}` so only the clicked control spins */
	creatingKey: string | null;
	setCreatingKey: (key: string | null) => void;
}

export function countActiveSidebarFilters(
	s: Pick<
		SidebarState,
		| "filterQuery"
		| "statusFilter"
		| "timeFilter"
		| "showArchived"
		| "archivedOnly"
		| "hideEmptyProjects"
	>,
): number {
	let count = 0;
	if (s.filterQuery.trim() !== "") count += 1;
	if (s.statusFilter !== "all") count += 1;
	if (s.timeFilter !== "all") count += 1;
	if (s.showArchived) count += 1;
	if (s.archivedOnly) count += 1;
	if (s.hideEmptyProjects) count += 1;
	return count;
}

export function filterSidebarSessions(
	sessions: SessionMeta[],
	workspaces: Workspace[],
	filters: {
		query: string;
		statusFilter: SidebarStatusFilter;
		timeFilter: SidebarTimeFilter;
		now?: number;
	},
): SessionMeta[] {
	const q = filters.query.trim().toLowerCase();
	if (!q && filters.statusFilter === "all" && filters.timeFilter === "all") {
		return sessions;
	}

	const now = filters.now ?? Date.now();
	let cutoffMs: number | null = null;
	if (filters.timeFilter === "today") {
		const d = new Date(now);
		cutoffMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	} else if (filters.timeFilter === "7days") {
		cutoffMs = now - 7 * 86_400_000;
	} else if (filters.timeFilter === "30days") {
		cutoffMs = now - 30 * 86_400_000;
	}

	const wsById = q ? new Map(workspaces.map((w) => [w.id, w])) : null;

	return sessions.filter((s) => {
		if (filters.statusFilter === "running" && s.status !== "working") return false;
		if (
			filters.statusFilter === "unread" &&
			!(s.unread || s.status === "review" || s.pending === "review")
		) {
			return false;
		}
		if (
			filters.statusFilter === "attention" &&
			!(
				s.status === "awaiting_approval" ||
				s.status === "awaiting_answer" ||
				s.status === "error" ||
				s.status === "interrupted" ||
				s.status === "review" ||
				s.pending !== null ||
				s.unread
			)
		) {
			return false;
		}

		if (cutoffMs !== null) {
			const ts = Date.parse(s.updatedAt || s.createdAt);
			if (!Number.isFinite(ts) || ts < cutoffMs) return false;
		}

		if (q) {
			const titleMatch = sessionDisplayName(s).toLowerCase().includes(q);
			const branchMatch = (s.git?.branch ?? "").toLowerCase().includes(q);
			const worktreeMatch = (s.git?.worktree ?? "").toLowerCase().includes(q);
			const wsName = s.workspaceId ? (wsById?.get(s.workspaceId)?.name ?? "") : "";
			const wsMatch = wsName.toLowerCase().includes(q);
			const cwdMatch = s.cwd.toLowerCase().includes(q);
			if (!titleMatch && !branchMatch && !worktreeMatch && !wsMatch && !cwdMatch) {
				return false;
			}
		}

		return true;
	});
}

function persistPrefsFromState(state: SidebarState): void {
	writeDisplayPrefs({
		groupBy: state.groupBy,
		sessionSort: state.sessionSort,
		projectSort: state.projectSort,
		autoPin: state.autoPin,
		hideEmptyProjects: state.hideEmptyProjects,
		showUnassigned: state.showUnassigned,
	});
}

const initialPrefs = readDisplayPrefs();

export const useSidebarStore = create<SidebarState>((set, get) => ({
	activeMode: readActiveMode(),
	setActiveMode: (mode: SpaceMode) => {
		writeActiveMode(mode);
		set({ activeMode: mode });
	},

	groupOpen: readCollapsedGroups(),
	setGroupOpen: (update) => {
		set((state) => {
			const next = typeof update === "function" ? update(state.groupOpen) : update;
			writeCollapsedGroups(next);
			return { groupOpen: next };
		});
	},
	toggleGroup: (key: string, defaultOpen = true) => {
		set((state) => {
			const current = state.groupOpen[key] !== undefined ? state.groupOpen[key] : defaultOpen;
			const next = { ...state.groupOpen, [key]: !current };
			writeCollapsedGroups(next);
			return { groupOpen: next };
		});
	},
	isGroupOpen: (key: string, defaultOpen = true) => {
		const open = get().groupOpen[key];
		return open !== undefined ? open : defaultOpen;
	},

	showArchived: false,
	setShowArchived: (showArchived: boolean) => set({ showArchived }),
	toggleShowArchived: () => set((s) => ({ showArchived: !s.showArchived })),

	groupBy: initialPrefs.groupBy,
	setGroupBy: (groupBy: SidebarGroupBy) => {
		set((state) => {
			const next = { ...state, groupBy };
			persistPrefsFromState(next);
			return { groupBy };
		});
	},
	sessionSort: initialPrefs.sessionSort,
	setSessionSort: (sessionSort: SidebarSessionSort) => {
		set((state) => {
			const next = { ...state, sessionSort };
			persistPrefsFromState(next);
			return { sessionSort };
		});
	},
	projectSort: initialPrefs.projectSort,
	setProjectSort: (projectSort: SidebarProjectSort) => {
		set((state) => {
			const next = { ...state, projectSort };
			persistPrefsFromState(next);
			return { projectSort };
		});
	},
	autoPin: initialPrefs.autoPin,
	setAutoPin: (autoPin: boolean) => {
		set((state) => {
			const next = { ...state, autoPin };
			persistPrefsFromState(next);
			return { autoPin };
		});
	},
	archivedOnly: false,
	setArchivedOnly: (archivedOnly: boolean) => set({ archivedOnly }),
	showUnassigned: initialPrefs.showUnassigned,
	setShowUnassigned: (showUnassigned: boolean) => {
		set((state) => {
			const next = { ...state, showUnassigned };
			persistPrefsFromState(next);
			return { showUnassigned };
		});
	},

	filterQuery: "",
	setFilterQuery: (filterQuery: string) => set({ filterQuery }),
	statusFilter: "all",
	setStatusFilter: (statusFilter: SidebarStatusFilter) => set({ statusFilter }),
	timeFilter: "all",
	setTimeFilter: (timeFilter: SidebarTimeFilter) => set({ timeFilter }),
	hideEmptyProjects: initialPrefs.hideEmptyProjects,
	setHideEmptyProjects: (hideEmptyProjects: boolean) => {
		set((state) => {
			const next = { ...state, hideEmptyProjects };
			persistPrefsFromState(next);
			return { hideEmptyProjects };
		});
	},
	resetSidebarFilters: () => {
		set((state) => {
			const next = { ...state, hideEmptyProjects: false };
			persistPrefsFromState(next);
			return {
				filterQuery: "",
				statusFilter: "all",
				timeFilter: "all",
				hideEmptyProjects: false,
				showArchived: false,
				archivedOnly: false,
			};
		});
	},

	expandedSections: {},
	setExpandedSections: (update) => {
		set((state) => {
			const next =
				typeof update === "function" ? update(state.expandedSections) : update;
			return { expandedSections: next };
		});
	},
	toggleSection: (key: string, defaultOpen = true) => {
		set((state) => {
			const current =
				state.expandedSections[key] !== undefined
					? state.expandedSections[key] === 1
					: defaultOpen;
			return {
				expandedSections: {
					...state.expandedSections,
					[key]: current ? 0 : 1,
				},
			};
		});
	},
	setSectionCount: (key: string, count: number) => {
		set((state) => ({
			expandedSections: {
				...state.expandedSections,
				[key]: count,
			},
		}));
	},

	creatingKey: null,
	setCreatingKey: (creatingKey: string | null) => set({ creatingKey }),
}));
