/**
 * Global toast notifications. Single store; <Toaster/> renders at app root.
 * Usage: toast.error("发送失败: …") / toast.success("已记入收集箱") / toast.info(…)
 */
import { create } from "zustand";

export type ToastKind = "info" | "success" | "error";

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface ToastItem {
	id: number;
	kind: ToastKind;
	text: string;
	action?: ToastAction;
}

interface ToastState {
	items: ToastItem[];
	push: (kind: ToastKind, text: string, ttlMs?: number, action?: ToastAction) => void;
	dismiss: (id: number) => void;
	pause: (id: number) => void;
	resume: (id: number) => void;
}

interface TimerEntry {
	timer: ReturnType<typeof setTimeout> | null;
	remaining: number;
	startedAt: number;
	paused: boolean;
}

const autoTimers = new Map<number, TimerEntry>();
function clearAutoTimer(id: number): void {
	const entry = autoTimers.get(id);
	if (entry?.timer !== null && entry?.timer !== undefined) {
		clearTimeout(entry.timer);
	}
	autoTimers.delete(id);
}
let seq = 0;

export const useToasts = create<ToastState>((set, get) => ({
	items: [],
	push: (kind, text, ttlMs = 3500, action) => {
		const id = ++seq;
		set((s) => {
			const kept = s.items.slice(-4);
			const keptIds = new Set(kept.map((t) => t.id));
			for (const old of s.items) {
				if (!keptIds.has(old.id)) {
					clearAutoTimer(old.id);
				}
			}
			return { items: [...kept, { id, kind, text, action }] };
		});
		if (ttlMs > 0) {
			const timer = setTimeout(() => {
				autoTimers.delete(id);
				get().dismiss(id);
			}, ttlMs);
			autoTimers.set(id, {
				timer,
				remaining: ttlMs,
				startedAt: Date.now(),
				paused: false,
			});
		}
	},
	dismiss: (id) => {
		clearAutoTimer(id);
		set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
	},
	pause: (id) => {
		const entry = autoTimers.get(id);
		if (!entry || entry.paused || entry.timer === null) return;
		clearTimeout(entry.timer);
		entry.timer = null;
		entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
		entry.paused = true;
	},
	resume: (id) => {
		const entry = autoTimers.get(id);
		if (!entry || !entry.paused) return;
		const alive = get().items.some((t) => t.id === id);
		if (!alive) {
			autoTimers.delete(id);
			return;
		}
		entry.paused = false;
		if (entry.remaining <= 0) {
			autoTimers.delete(id);
			get().dismiss(id);
			return;
		}
		entry.startedAt = Date.now();
		entry.timer = setTimeout(() => {
			autoTimers.delete(id);
			get().dismiss(id);
		}, entry.remaining);
	},
}));

export const toast = {
	info: (text: string, ttlMs?: number, action?: ToastAction) => useToasts.getState().push("info", text, ttlMs, action),
	success: (text: string, ttlMs?: number, action?: ToastAction) =>
		useToasts.getState().push("success", text, ttlMs, action),
	error: (text: string, ttlMs?: number, action?: ToastAction) =>
		useToasts.getState().push("error", text, ttlMs, action),
};
