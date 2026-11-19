import type { UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { Schedule, ScheduleDraft, ScheduleRun } from "../../lib/contracts";
import { onSchedulesChanged } from "../../lib/events";
import {
	deleteSchedule as ipcDeleteSchedule,
	listScheduleRuns,
	listSchedules,
	runScheduleNow,
	saveSchedule as ipcSaveSchedule,
	setScheduleEnabled,
} from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { tNow } from "../../stores/language";

export type EditorTab = "settings" | "history";
export type WorkspaceTab = "overview" | "config";

function toWorkspaceTab(tab?: EditorTab): WorkspaceTab {
	return tab === "history" ? "overview" : "config";
}

const SEEN_KEY = "omp:schedules:seenRuns";
/** Cap the seen list so localStorage never grows unboundedly. */
const SEEN_CAP = 400;

function readSeenRuns(): Record<string, true> {
	try {
		const raw = localStorage.getItem(SEEN_KEY);
		if (!raw) return {};
		const arr = JSON.parse(raw);
		if (!Array.isArray(arr)) return {};
		const out: Record<string, true> = {};
		for (const id of arr.slice(-SEEN_CAP)) {
			if (typeof id === "string") out[id] = true;
		}
		return out;
	} catch {
		return {};
	}
}

function persistSeenRuns(seen: Record<string, true>): void {
	try {
		localStorage.setItem(SEEN_KEY, JSON.stringify(Object.keys(seen)));
	} catch {
		// Storage unavailable (private mode); seen state is best-effort.
	}
}

export interface SchedulesState {
	schedules: Schedule[];
	runs: Record<string, ScheduleRun[]>;
	loading: boolean;
	/** Last load failure (full text); null when the last load succeeded. */
	loadError: string | null;
	runningScheduleIds: Record<string, boolean>;
	/** Run ids the user has already seen (opened history/session for). */
	seenRuns: Record<string, true>;
	/** Selected automation displayed in the single-canvas Workspace; null = Home/Empty list. */
	selectedScheduleId: string | null;
	/** Active Workspace tab (`overview` for 概览与记录, `config` for 规则配置). */
	workspaceTab: WorkspaceTab;
	/** True when Workspace is creating a brand-new automation. */
	isCreating: boolean;
	/** True when the conversational composer studio is open for creating a new automation. */
	creatingViaChat: boolean;
	/** Optional subpage back handler registered by SchedulesPage (handles dirty confirm). */
	subpageBackHandler: (() => void) | null;
	isEditorOpen: boolean;
	editingSchedule: Schedule | null;
	draftTemplate: Partial<ScheduleDraft> | null;
	/** Which tab the editor opens on (history when a run just failed). */
	editorTab: EditorTab;

	load: () => Promise<void>;
	loadRuns: (scheduleId: string, limit?: number) => Promise<void>;
	markRunSeen: (runId: string) => void;
	toggleEnabled: (id: string, enabled: boolean) => Promise<void>;
	runNow: (id: string) => Promise<void>;
	removeSchedule: (id: string) => Promise<void>;
	saveSchedule: (draft: ScheduleDraft) => Promise<Schedule | null>;
	setCreatingViaChat: (open: boolean) => void;
	setSubpageBackHandler: (handler: (() => void) | null) => void;
	leaveSubpage: () => void;
	openHome: () => void;
	openWorkspace: (schedule: Schedule, tab?: WorkspaceTab) => void;
	setWorkspaceTab: (tab: WorkspaceTab) => void;
	openCreate: (template?: Partial<ScheduleDraft>) => void;
	openEdit: (schedule: Schedule, tab?: EditorTab) => void;
	closeEditor: () => void;
}

let unlisten: UnlistenFn | null = null;

export const useSchedulesStore = create<SchedulesState>((set, get) => ({
	schedules: [],
	runs: {},
	loading: false,
	loadError: null,
	runningScheduleIds: {},
	seenRuns: readSeenRuns(),
	selectedScheduleId: null,
	workspaceTab: "overview",
	isCreating: false,
	creatingViaChat: false,
	subpageBackHandler: null,
	isEditorOpen: false,
	editingSchedule: null,
	draftTemplate: null,
	editorTab: "settings",

	load: async () => {
		set({ loading: true });
		try {
			// Start listening to schedules:changed once
			if (!unlisten) {
				unlisten = await onSchedulesChanged(() => {
					// Refresh schedules and every run list currently loaded
					void get().load();
					for (const sid of Object.keys(get().runs)) {
						void get().loadRuns(sid);
					}
				});
			}

			const list = await listSchedules();
			set({ schedules: list, loading: false, loadError: null });
		} catch (e) {
			console.error("Failed to load schedules:", e);
			set({ loading: false, loadError: e instanceof Error ? e.message : String(e) });
		}
	},

	loadRuns: async (scheduleId: string, limit = 20) => {
		try {
			const runs = await listScheduleRuns(scheduleId, limit);
			set((state) => ({
				runs: { ...state.runs, [scheduleId]: runs },
			}));
		} catch (e) {
			console.error(`Failed to load runs for schedule ${scheduleId}:`, e);
		}
	},

	markRunSeen: (runId: string) => {
		const seen = get().seenRuns;
		if (seen[runId]) return;
		const next: Record<string, true> = { ...seen, [runId]: true };
		set({ seenRuns: next });
		persistSeenRuns(next);
	},

	toggleEnabled: async (id: string, enabled: boolean) => {
		try {
			const updated = await setScheduleEnabled(id, enabled);
			set((state) => ({
				schedules: state.schedules.map((s) => (s.id === id ? updated : s)),
			}));
		} catch (e) {
			toast.error(tNow("schedules.toastToggleStatusFailed", { error: String(e) }));
		}
	},

	runNow: async (id: string) => {
		set((state) => ({
			runningScheduleIds: { ...state.runningScheduleIds, [id]: true },
		}));
		try {
			await runScheduleNow(id);
			toast.success(tNow("schedules.toastTriggerSuccess"));
			void get().load();
			void get().loadRuns(id);
		} catch (e) {
			toast.error(tNow("schedules.toastTriggerFailed", { error: String(e) }));
		} finally {
			set((state) => ({
				runningScheduleIds: { ...state.runningScheduleIds, [id]: false },
			}));
		}
	},

	removeSchedule: async (id: string) => {
		try {
			await ipcDeleteSchedule(id);
			set((state) => {
				const { [id]: _dropped, ...runs } = state.runs;
				const clearingSelected = state.selectedScheduleId === id;
				return {
					schedules: state.schedules.filter((s) => s.id !== id),
					runs,
					...(clearingSelected
						? {
								selectedScheduleId: null,
								isCreating: false,
								isEditorOpen: false,
								editingSchedule: null,
							}
						: {}),
				};
			});
			toast.success(tNow("schedules.toastDeleteSuccess"));
		} catch (e) {
			toast.error(tNow("schedules.toastDeleteFailed", { error: String(e) }));
		}
	},

	saveSchedule: async (draft: ScheduleDraft) => {
		try {
			const saved = await ipcSaveSchedule(draft);
			toast.success(draft.id ? tNow("schedules.toastTaskUpdated") : tNow("schedules.toastTaskCreated"));
			set((state) => {
				const idx = state.schedules.findIndex((s) => s.id === saved.id);
				const nextList =
					idx >= 0
						? state.schedules.map((s) => (s.id === saved.id ? saved : s))
						: [saved, ...state.schedules];
				return {
					schedules: nextList,
					selectedScheduleId: saved.id,
					workspaceTab: "overview",
					isCreating: false,
					isEditorOpen: false,
					editingSchedule: null,
					draftTemplate: null,
				};
			});
			return saved;
		} catch (e) {
			toast.error(tNow("schedules.toastSaveFailed", { error: String(e) }));
			return null;
		}
	},

	setCreatingViaChat: (open: boolean) => {
		set({ creatingViaChat: open });
	},

	setSubpageBackHandler: (handler: (() => void) | null) => {
		set({ subpageBackHandler: handler });
	},

	leaveSubpage: () => {
		const handler = get().subpageBackHandler;
		if (handler) {
			handler();
			return;
		}
		set({ creatingViaChat: false });
		get().openHome();
	},

	openHome: () => {
		set({
			selectedScheduleId: null,
			workspaceTab: "overview",
			isCreating: false,
			creatingViaChat: false,
			isEditorOpen: false,
			editingSchedule: null,
			draftTemplate: null,
			editorTab: "settings",
		});
	},

	openWorkspace: (schedule: Schedule, tab: WorkspaceTab = "overview") => {
		set({
			selectedScheduleId: schedule.id,
			workspaceTab: tab,
			isCreating: false,
			creatingViaChat: false,
			isEditorOpen: tab === "config",
			editingSchedule: schedule,
			draftTemplate: null,
			editorTab: tab === "overview" ? "history" : "settings",
		});
		void get().loadRuns(schedule.id, 30);
	},

	setWorkspaceTab: (tab: WorkspaceTab) => {
		set((state) => {
			if (state.isCreating) return { workspaceTab: "config" };
			return {
				workspaceTab: tab,
				isEditorOpen: tab === "config",
				editorTab: tab === "overview" ? "history" : "settings",
			};
		});
	},

	openCreate: (template?: Partial<ScheduleDraft>) => {
		set({
			selectedScheduleId: null,
			workspaceTab: "config",
			isCreating: true,
			creatingViaChat: false,
			isEditorOpen: true,
			editingSchedule: null,
			draftTemplate: template ?? null,
			editorTab: "settings",
		});
	},

	openEdit: (schedule: Schedule, tab: EditorTab = "settings") => {
		get().openWorkspace(schedule, toWorkspaceTab(tab));
	},

	closeEditor: () => {
		get().openHome();
	},
}));
