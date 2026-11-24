import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, CircleCheck } from "lucide-react";
import { errorMessage } from "../core/api";
import { isNonCompositedTestEnv, prefersReducedMotion } from "./motion";

export type ToastKind = "info" | "success" | "error";

interface ToastItem {
	id: number;
	text: string;
	kind: ToastKind;
	action?: { label: string; onClick: () => void | Promise<void> };
	busy?: boolean;
	exiting?: boolean;
}

const MAX_VISIBLE = 3;
const EXIT_MS = 160;
let items: readonly ToastItem[] = [];
let nextId = 1;
const timers = new Map<number, number>();
const listeners = new Set<() => void>();

function emit(): void {
	for (const l of listeners) l();
}
function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
function getItems(): readonly ToastItem[] {
	return items;
}

function clearToastTimer(id: number): void {
	const timer = timers.get(id);
	if (timer !== undefined) {
		window.clearTimeout(timer);
		timers.delete(id);
	}
}

function dismissToast(id: number): void {
	clearToastTimer(id);
	const current = items.find((t) => t.id === id);
	if (!current || current.exiting) return;
	const exitMs = prefersReducedMotion() || isNonCompositedTestEnv() ? 0 : EXIT_MS;
	if (exitMs <= 0) {
		items = items.filter((t) => t.id !== id);
		emit();
		return;
	}
	items = items.map((t) => (t.id === id ? { ...t, exiting: true } : t));
	emit();
	const removeTimer = window.setTimeout(() => {
		timers.delete(id);
		items = items.filter((t) => t.id !== id);
		emit();
	}, exitMs);
	timers.set(id, removeTimer);
}

export function toast(text: string, opts?: { kind?: ToastKind; ms?: number; action?: { label: string; onClick: () => void | Promise<void> } }): void {
	const kind = opts?.kind ?? "info";
	const ms = opts?.ms ?? (opts?.action ? 5000 : kind === "error" ? 4000 : 2400);
	const id = nextId++;
	const next = [...items, { id, text, kind, action: opts?.action }];
	const evicted = next.slice(0, Math.max(0, next.length - MAX_VISIBLE));
	for (const old of evicted) clearToastTimer(old.id);
	items = next.slice(-MAX_VISIBLE);
	emit();
	const timer = window.setTimeout(() => {
		timers.delete(id);
		const target = items.find((t) => t.id === id);
		if (!target || target.busy) return;
		dismissToast(id);
	}, ms);
	timers.set(id, timer);
}

async function runAction(id: number): Promise<void> {
	const item = items.find((t) => t.id === id);
	if (!item?.action || item.busy || item.exiting) return;
	const action = item.action;
	clearToastTimer(id);
	items = items.map((t) => (t.id === id ? { ...t, action: undefined, busy: true } : t));
	emit();
	try {
		await action.onClick();
		dismissToast(id);
	} catch (e) {
		clearToastTimer(id);
		items = items.filter((t) => t.id !== id);
		toast(errorMessage(e), { kind: "error", ms: 8000 });
	}
}

export function ToastHost() {
	const list = useSyncExternalStore(subscribe, getItems, getItems);
	const node = (
		<div
			aria-live="polite"
			className="pointer-events-none fixed inset-x-0 z-(--z-toast) flex flex-col items-center justify-end gap-2 px-4"
			style={{
				top: "var(--m-vv-top, 0px)",
				height: "var(--m-vh, 100dvh)",
				paddingLeft: "max(16px, var(--m-safe-left))",
				paddingRight: "max(16px, var(--m-safe-right))",
				paddingBottom: "calc(max(0px, var(--m-safe-bottom) - var(--m-kb, 0px)) + 88px)",
			}}
		>
			{list.map((t) => (
				<div
					key={t.id}
					role="status"
					data-exiting={t.exiting ? "true" : undefined}
					className={`m-selectable pointer-events-auto flex max-w-full items-center gap-2 rounded-m-md px-4 py-3 text-m-sm shadow-m-pop transition-[opacity,transform,translate,scale] duration-(--m-dur-fast) ease-m starting:translate-y-2 starting:opacity-0 motion-reduce:transition-opacity motion-reduce:starting:translate-y-0 ${
						t.exiting ? "pointer-events-none translate-y-1.5 opacity-0 motion-reduce:translate-y-0" : "translate-y-0 opacity-100"
					} ${
						t.kind === "error" ? "bg-m-danger-bg text-m-danger" : "bg-m-text text-m-bg"
					}`}
				>
					{t.kind === "success" && <CircleCheck size={16} className="shrink-0" />}
					{t.kind === "error" && <CircleAlert size={16} className="shrink-0" />}
						<span className="min-w-0 whitespace-pre-wrap break-words">{t.text}</span>
						{(t.action || t.busy) && (
							<button
								type="button"
								disabled={t.busy}
								onClick={() => void runAction(t.id)}
								className="min-h-11 min-w-11 shrink-0 whitespace-nowrap rounded-m-pill px-3 font-semibold disabled:opacity-50"
							>
								{t.busy ? "处理中" : t.action?.label}
							</button>
						)}
				</div>
			))}
		</div>
	);
	return typeof document !== "undefined" ? createPortal(node, document.body) : node;
}
