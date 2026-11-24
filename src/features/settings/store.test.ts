import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../../lib/contracts";
import * as ipc from "../../lib/ipc";
import { captureDiagnosticError, recordDiagnostic, setDiagnosticsEnabled } from "../../lib/diagnostics";
import { _resetSettingsStore, DEFAULT_SETTINGS, handleExternalSettingsChange, startSettingsSync, useSettings } from "./store";

const eventMocks = vi.hoisted(() => ({
	handler: null as (() => void) | null,
	unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async (_event: string, cb: () => void) => {
		eventMocks.handler = cb;
		return eventMocks.unlisten;
	}),
}));
beforeEach(() => {
	_resetSettingsStore();
	useSettings.setState({ settings: null, error: null });
	vi.useFakeTimers();
	vi.stubGlobal("document", {});
	vi.mocked(invoke).mockReset().mockResolvedValue({ status: "accepted", accepted: 20 });
});

afterEach(() => {
	setDiagnosticsEnabled(false);
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function recordObservation(removedRows: number): void {
	recordDiagnostic({ event: "frontend.state_reconciled", source: "state_reconcile", occurredAt: new Date().toISOString(), removedRows });
}

function diagnosticBatches() {
	return vi.mocked(invoke).mock.calls.filter(([command]) => command === "diagnostics_record").map(([, args]) => args);
}

const mockSettings: Settings = {
	...DEFAULT_SETTINGS,
	defaultApprovalMode: "write",
};

describe("settings store", () => {
	it.each(["skip", "coalesce", "queue", "parallel"] as const)("persists and reloads the global %s overlap policy", async (automationOverlapPolicy) => {
		useSettings.setState({ settings: { ...mockSettings }, error: null });
		const saved = { ...mockSettings, automationOverlapPolicy };
		const patchSpy = vi.spyOn(ipc, "patchSettings").mockImplementation(async (patch) => ({ ...mockSettings, ...patch }));
		await useSettings.getState().update({ automationOverlapPolicy });
		expect(patchSpy).toHaveBeenCalledWith({ automationOverlapPolicy });
		useSettings.setState({ settings: null });
		await useSettings.getState().load();
		expect(useSettings.getState().settings?.automationOverlapPolicy).toBe(automationOverlapPolicy);
	});

	it("serializes concurrent updates and rolls back to confirmed state on error", async () => {
		useSettings.setState({ settings: { ...mockSettings }, error: null });

		let callCount = 0;
		let serverState = { ...mockSettings };
		const patchSpy = vi.spyOn(ipc, "patchSettings").mockImplementation(async (patch) => {
			callCount++;
			if (callCount === 2) {
				throw new Error("Disk full");
			}
			serverState = { ...serverState, ...patch };
			return { ...serverState };
		});
		// Call update twice concurrently
		const p1 = useSettings.getState().update({ systemDetection: false });
		const p2 = useSettings.getState().update({ dockBadgeEnabled: false });

		await expect(Promise.all([p1, p2])).rejects.toThrow("Disk full");

		// Should have rolled back to the last confirmed settings
		const current = useSettings.getState().settings;
		expect(current?.systemDetection).toBe(false);
		expect(current?.dockBadgeEnabled).toBe(true);
		expect(useSettings.getState().error).toContain("Disk full");

		patchSpy.mockRestore();
	});

	it("rolls back only the failed update when A fails and B succeeds", async () => {
		_resetSettingsStore();
		useSettings.setState({ settings: { ...mockSettings }, error: null });

		let callCount = 0;
		let serverState = { ...mockSettings };
		const patchSpy = vi.spyOn(ipc, "patchSettings").mockImplementation(async (patch) => {
			callCount++;
			if (callCount === 1) {
				throw new Error("Update A failed");
			}
			serverState = { ...serverState, ...patch };
			return { ...serverState };
		});
		// Call update A and update B concurrently
		const p1 = useSettings.getState().update({ systemDetection: false });
		const p2 = useSettings.getState().update({ dockBadgeEnabled: false });

		await expect(p1).rejects.toThrow("Update A failed");
		await expect(p2).resolves.toBeUndefined();

		const current = useSettings.getState().settings;
		// A should have rolled back to initial (true), B should remain applied (true)
		expect(current?.systemDetection).toBe(true);
		expect(current?.dockBadgeEnabled).toBe(false);

		patchSpy.mockRestore();
	});

	it("loads a saved-false preference without emitting startup or disabled observations", async () => {
		vi.spyOn(ipc, "getSettings").mockResolvedValue({ ...mockSettings, diagnosticsEnabled: false });
		let serverState = { ...mockSettings, diagnosticsEnabled: false };
		vi.spyOn(ipc, "patchSettings").mockImplementation(async (patch) => {
			serverState = { ...serverState, ...patch };
			return { ...serverState };
		});
		recordObservation(1);
		await useSettings.getState().load();
		recordObservation(2);
		captureDiagnosticError("bootstrap", new Error("disabled"));
		await vi.runAllTimersAsync();
		expect(diagnosticBatches()).toEqual([]);
		await useSettings.getState().update({ diagnosticsEnabled: true });
		recordObservation(3);
		await vi.runAllTimersAsync();
		expect(diagnosticBatches()).toEqual([{ events: [expect.objectContaining({ removedRows: 3 })], droppedEvents: 0 }]);
	});

	it("stops immediately for an optimistic off and restores future recording after a failed save", async () => {
		vi.spyOn(ipc, "getSettings").mockResolvedValue({ ...mockSettings });
		let rejectSave!: (error: Error) => void;
		// The app targets ES2021, where Promise.withResolvers is not available.
		vi.spyOn(ipc, "patchSettings").mockReturnValue(new Promise<Settings>((_, reject) => { rejectSave = reject; }));
		await useSettings.getState().load();
		const unsubscribe = useSettings.subscribe((state, previous) => {
			if (state.settings?.diagnosticsEnabled !== previous.settings?.diagnosticsEnabled) recordObservation(99);
		});
		recordObservation(1);
		const saving = useSettings.getState().update({ diagnosticsEnabled: false });
		unsubscribe();
		expect(useSettings.getState().settings?.diagnosticsEnabled).toBe(false);
		recordObservation(2);
		await vi.runAllTimersAsync();
		expect(diagnosticBatches()).toEqual([]);
		const rejected = expect(saving).rejects.toThrow("Disk full");
		rejectSave(new Error("Disk full"));
		await rejected;
		expect(useSettings.getState().settings?.diagnosticsEnabled).toBe(true);
		recordObservation(3);
		await vi.runAllTimersAsync();
		expect(diagnosticBatches()).toEqual([{ events: [expect.objectContaining({ removedRows: 3 })], droppedEvents: 0 }]);
	});

	it("discards optimistic enable observations when a failed save rolls back to saved-false", async () => {
		vi.spyOn(ipc, "getSettings").mockResolvedValue({ ...mockSettings, diagnosticsEnabled: false });
		vi.spyOn(ipc, "patchSettings").mockRejectedValue(new Error("Disk full"));
		await useSettings.getState().load();
		const saving = useSettings.getState().update({ diagnosticsEnabled: true });
		recordObservation(1);
		await expect(saving).rejects.toThrow("Disk full");
		expect(useSettings.getState().settings?.diagnosticsEnabled).toBe(false);
		recordObservation(2);
		await vi.runAllTimersAsync();
		expect(diagnosticBatches()).toEqual([]);
	});

	it.each(["before", "after"] as const)("ignores an old reload resolved %s the off save succeeds", async (order) => {
		let resolveReload!: (settings: Settings) => void;
		let confirmOff!: () => void;
		// The app targets ES2021, where Promise.withResolvers is not available.
		const oldReload = new Promise<Settings>((resolve) => { resolveReload = resolve; });
		const getSpy = vi.spyOn(ipc, "getSettings")
			.mockResolvedValueOnce({ ...mockSettings })
			.mockReturnValueOnce(oldReload);
		let serverState = { ...mockSettings };
		const patchSpy = vi.spyOn(ipc, "patchSettings")
			.mockImplementationOnce((patch) => new Promise<Settings>((resolve) => {
				confirmOff = () => {
					serverState = { ...serverState, ...patch };
					resolve({ ...serverState });
				};
			}))
			.mockImplementation(async (patch) => {
				serverState = { ...serverState, ...patch };
				return { ...serverState };
			});
		await useSettings.getState().load();
		const reloading = useSettings.getState().load();
		await Promise.resolve();
		expect(getSpy).toHaveBeenCalledTimes(2);
		const saving = useSettings.getState().update({ diagnosticsEnabled: false });
		await Promise.resolve();
		expect(patchSpy.mock.calls[0][0]).toEqual({ diagnosticsEnabled: false });
		if (order === "before") {
			resolveReload({ ...mockSettings });
			await reloading;
			expect(useSettings.getState().settings?.diagnosticsEnabled).toBe(false);
			recordObservation(1);
			await vi.runAllTimersAsync();
			expect(diagnosticBatches()).toEqual([]);
			confirmOff();
			await saving;
		} else {
			confirmOff();
			await saving;
			resolveReload({ ...mockSettings });
			await reloading;
		}
		expect(useSettings.getState().settings?.diagnosticsEnabled).toBe(false);
		recordObservation(2);
		await vi.runAllTimersAsync();
		expect(diagnosticBatches()).toEqual([]);
		await useSettings.getState().update({ dockBadgeEnabled: false });
		expect(patchSpy.mock.calls[1][0]).toEqual({ dockBadgeEnabled: false });
		expect(useSettings.getState().settings?.diagnosticsEnabled).toBe(false);
		recordObservation(3);
		await vi.runAllTimersAsync();
		expect(diagnosticBatches()).toEqual([]);
	});

	it("reloads settings on settings:changed so subsequent desktop saves do not revert mobile changes (H8)", async () => {
		const mobileUpdated: Settings = { ...mockSettings, automationBackgroundEnabled: false, defaultApprovalMode: "ask" };
		const getSpy = vi.spyOn(ipc, "getSettings")
			.mockResolvedValueOnce({ ...mockSettings })
			.mockResolvedValueOnce(mobileUpdated);
		const patchSpy = vi.spyOn(ipc, "patchSettings").mockImplementation(async (patch) => ({ ...mobileUpdated, ...patch }));

		await useSettings.getState().load();
		const stop = startSettingsSync();
		await Promise.resolve();
		expect(eventMocks.handler).toBeTypeOf("function");

		eventMocks.handler!();
		await vi.waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2));
		expect(useSettings.getState().settings?.automationBackgroundEnabled).toBe(false);
		expect(useSettings.getState().settings?.defaultApprovalMode).toBe("ask");

		// Unrelated desktop save must rebase on refreshed lastConfirmed and preserve mobile's changes
		await useSettings.getState().update({ dockBadgeEnabled: false });
		expect(patchSpy).toHaveBeenCalledWith({ dockBadgeEnabled: false });
		expect(useSettings.getState().settings).toMatchObject({
			automationBackgroundEnabled: false,
			defaultApprovalMode: "ask",
			dockBadgeEnabled: false,
		});
		stop();
		expect(eventMocks.unlisten).toHaveBeenCalledTimes(1);
	});

	it("defers external settings:changed reload while a desktop save is in flight (H8)", async () => {
		let finishSave!: (s: Settings) => void;
		const getSpy = vi.spyOn(ipc, "getSettings")
			.mockResolvedValueOnce({ ...mockSettings })
			.mockResolvedValueOnce({ ...mockSettings, dockBadgeEnabled: false, automationOverlapPolicy: "queue" });
		vi.spyOn(ipc, "patchSettings").mockImplementationOnce(
			() => new Promise<Settings>((resolve) => { finishSave = resolve; }),
		);

		await useSettings.getState().load();
		const saving = useSettings.getState().update({ dockBadgeEnabled: false });
		await Promise.resolve();

		// Event arrives mid-write: must NOT trigger getSettings() yet
		handleExternalSettingsChange();
		expect(getSpy).toHaveBeenCalledTimes(1);
		expect(useSettings.getState().settings?.dockBadgeEnabled).toBe(false);

		finishSave({ ...mockSettings, dockBadgeEnabled: false });
		await saving;
		await vi.waitFor(() =>
			expect(useSettings.getState().settings?.automationOverlapPolicy).toBe("queue"),
		);
		expect(getSpy).toHaveBeenCalledTimes(2);
	});

	it("sends only the changed fields via patchSettings so stale desktop state cannot revert concurrent mobile edits (H2)", async () => {
		const diskBeforeEdit: Settings = {
			...mockSettings,
			automationBackgroundEnabled: false,
			automationOverlapPolicy: "queue",
		};
		vi.spyOn(ipc, "getSettings").mockResolvedValueOnce({ ...mockSettings });
		const saveSpy = vi.spyOn(ipc, "saveSettings");
		const patchSpy = vi.spyOn(ipc, "patchSettings").mockImplementationOnce(async (patch) => ({
			...diskBeforeEdit,
			...patch,
		}));

		await useSettings.getState().load();
		// Desktop edits an unrelated field BEFORE settings:changed arrives
		await useSettings.getState().update({ dockBadgeEnabled: false });

		expect(saveSpy).not.toHaveBeenCalled();
		expect(patchSpy).toHaveBeenCalledTimes(1);
		expect(patchSpy).toHaveBeenCalledWith({ dockBadgeEnabled: false });
		expect(useSettings.getState().settings).toMatchObject({
			dockBadgeEnabled: false,
			automationBackgroundEnabled: false,
			automationOverlapPolicy: "queue",
		});
	});
});
