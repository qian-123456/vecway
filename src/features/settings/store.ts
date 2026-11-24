/** [D] Settings store shared by SettingsPage and TopCapsule. */

import { create } from "zustand";
import type { Settings } from "../../lib/contracts";
import { onSettingsChanged } from "../../lib/events";
import { getSettings, patchSettings } from "../../lib/ipc";
import { setDiagnosticsEnabled } from "../../lib/diagnostics";

/** Mirror of `Settings::default()` in contracts.rs (used by import / restore). */
export const DEFAULT_SETTINGS: Settings = {
	diagnosticsEnabled: true,
	systemDetection: true,
	smartContextRouting: false,
	idleSuspendMinutes: 10,
	defaultApprovalMode: "yolo",
	ompBinary: "omp",
	notifyTurnEnd: true,
	notifyApproval: true,
	notifyExit: true,
	notifySound: false,
	capsuleVisible: true,
	mobileEnabled: false,
	mobilePort: 7788,
	tunnelMode: "off",
	tunnelName: null,
	tunnelHostname: null,
	mobileIpv6Enabled: false,
	mobileIpv6Port: 7789,
	mobileLanTlsPort: 7790,
	ddnsEnabled: false,
	ddnsZoneId: null,
	ddnsHostname: null,
	quickCaptureShortcut: "CommandOrControl+Shift+I",
	inboxWindowHours: 24,
	ompCheckIntervalHours: 24,
	notifyQuietFrom: null,
	notifyQuietTo: null,
	newSessionModel: null,
	dockBadgeEnabled: true,
	sessionTurnAutoRefresh: true,
	sessionGroupByWorktree: true,
	turnCheckpoints: null,
	queueAutoSend: null,
	ompAutoUpdate: null,
	gitDeliveryMode: "pr",
	doctorModel: "smol",
	doctorAutoMode: "manual",
	doctorIdleMinutes: 30,
	doctorScheduleTime: "23:00",
	privacyRevealDefault: null,
	windowWorktreeTitle: true,
	sideChatModel: null,
	visualizeEnabled: true,
	sendShortcut: "enter",
	followUpBehavior: "steer",
	automationBackgroundEnabled: true,
	automationOverlapPolicy: "skip",
};

export interface SettingsState {
	settings: Settings | null;
	error: string | null;
	load(): Promise<void>;
	/** Merge a patch and persist; reverts on failure. */
	update(patch: Partial<Settings>): Promise<void>;
}

let loading: Promise<void> | null = null;
let lastConfirmed: Settings | null = null;
let saveQueue: Promise<void> = Promise.resolve();
const keyRevisions = new Map<keyof Settings, number>();
let currentRev = 0;
let activeSaves = 0;
let pendingExternalReload = false;

export function _resetSettingsStore(): void {
	loading = null;
	lastConfirmed = null;
	keyRevisions.clear();
	currentRev = 0;
	saveQueue = Promise.resolve();
	activeSaves = 0;
	pendingExternalReload = false;
}

export const useSettings = create<SettingsState>((set, get) => ({
	settings: null,
	error: null,
	load: () => {
		if (loading) return loading;
		const rev = currentRev;
		// Read after older saves; discard the snapshot if a newer edit starts meanwhile.
		loading = saveQueue.then(() => getSettings())
			.then((settings) => {
				if (currentRev !== rev) return;
				setDiagnosticsEnabled(settings.diagnosticsEnabled);
				lastConfirmed = settings;
				keyRevisions.clear();
				set({ settings, error: null });
			})
			.catch((e) => {
				if (currentRev === rev) set({ error: String(e) });
			})
			.finally(() => {
				loading = null;
				if (pendingExternalReload && activeSaves === 0) {
					pendingExternalReload = false;
					void useSettings.getState().load();
				}
			});
		return loading;
	},
	update: async (patch) => {
		const current = get().settings;
		if (!current) return;
		if (!lastConfirmed) {
			lastConfirmed = current;
		}
		const rev = ++currentRev;
		const prevSnapshot = { ...current };
		for (const k of Object.keys(patch) as (keyof Settings)[]) {
			keyRevisions.set(k, rev);
		}
		const next = { ...current, ...patch };
		setDiagnosticsEnabled(next.diagnosticsEnabled);
		set({ settings: next });

		activeSaves += 1;
		const queued = saveQueue.then(async () => {
			try {
				const saved = await patchSettings(patch);
				lastConfirmed = saved;
				for (const k of Object.keys(patch) as (keyof Settings)[]) {
					if (keyRevisions.get(k) === rev) keyRevisions.delete(k);
				}
				const nextSettings: Settings = { ...saved };
				const currentState = get().settings;
				if (currentState) {
					for (const k of Object.keys(currentState) as (keyof Settings)[]) {
						const keyRev = keyRevisions.get(k);
						if (keyRev !== undefined && keyRev !== rev) {
							(nextSettings as unknown as Record<string, unknown>)[k] = currentState[k];
						}
					}
				}
				setDiagnosticsEnabled(nextSettings.diagnosticsEnabled);
				set({ settings: nextSettings, error: null });
			} catch (e) {
				const revertPatch: Partial<Settings> = {};
				for (const k of Object.keys(patch) as (keyof Settings)[]) {
					if (keyRevisions.get(k) === rev) {
						if (lastConfirmed && lastConfirmed[k] !== undefined) {
							(revertPatch as Record<string, unknown>)[k] = lastConfirmed[k];
						} else if (prevSnapshot[k] !== undefined) {
							(revertPatch as Record<string, unknown>)[k] = prevSnapshot[k];
						}
						keyRevisions.delete(k);
					}
				}
				set((state) => {
					const settings = state.settings ? { ...state.settings, ...revertPatch } : null;
					setDiagnosticsEnabled(settings?.diagnosticsEnabled ?? false);
					return { settings, error: String(e) };
				});
				throw e;
			}
		}).finally(() => {
			activeSaves = Math.max(0, activeSaves - 1);
			if (pendingExternalReload && activeSaves === 0 && !loading) {
				pendingExternalReload = false;
				void useSettings.getState().load();
			}
		});

		saveQueue = queued.catch(() => {
			// keep queue running for subsequent updates
		});

		await queued;
	},
}));

/** Load settings once (idempotent) and return them. */
export function ensureSettings(): void {
	const s = useSettings.getState();
	if (!s.settings) void s.load();
}

/** Reload settings when changed externally (e.g. mobile), deferring if a save or load is active. */
export function handleExternalSettingsChange(): void {
	if (activeSaves > 0 || loading) {
		pendingExternalReload = true;
		return;
	}
	void useSettings.getState().load();
}

/** Subscribe to `"settings:changed"` events and refresh settings store safely. */
export function startSettingsSync(): () => void {
	let cancelled = false;
	let unlisten: (() => void) | null = null;
	void onSettingsChanged(() => {
		handleExternalSettingsChange();
	})
		.then((fn) => {
			if (cancelled) fn();
			else unlisten = fn;
		})
		.catch(() => {});
	return () => {
		cancelled = true;
		unlisten?.();
		unlisten = null;
	};
}
