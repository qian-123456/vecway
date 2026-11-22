import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useToasts, type ToastItem, type ToastKind } from "../lib/toast";
import { useT } from "../stores/language";

const EXIT_DURATION_MS = 180;

type RenderedToast = ToastItem & { exiting?: boolean };
const ICONS: Record<ToastKind, typeof Info> = {
	info: Info,
	success: CheckCircle2,
	error: AlertCircle,
};

const TINT: Record<ToastKind, string> = {
	info: "text-neutral-200",
	success: "text-emerald-400",
	error: "text-rose-400",
};

/** Fixed bottom-right stack; mount once in App. */
export function Toaster() {
	const { t: tr } = useT();
	const items = useToasts((s) => s.items);
	const dismiss = useToasts((s) => s.dismiss);
	const pause = useToasts((s) => s.pause);
	const resume = useToasts((s) => s.resume);
	const [rendered, setRendered] = useState<RenderedToast[]>(() => items);
	const exitTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

	useEffect(() => {
		const activeIds = new Set(items.map((t) => t.id));
		setRendered((prev) => {
			const next: RenderedToast[] = [];
			const seen = new Set<number>();
			for (const existing of prev) {
				if (activeIds.has(existing.id)) {
					const fresh = items.find((t) => t.id === existing.id)!;
					next.push(fresh);
					seen.add(existing.id);
				} else {
					next.push(existing.exiting ? existing : { ...existing, exiting: true });
					seen.add(existing.id);
					if (!exitTimersRef.current.has(existing.id)) {
						const timer = setTimeout(() => {
							exitTimersRef.current.delete(existing.id);
							setRendered((cur) => cur.filter((item) => item.id !== existing.id));
						}, EXIT_DURATION_MS);
						exitTimersRef.current.set(existing.id, timer);
					}
				}
			}
			for (const incoming of items) {
				if (!seen.has(incoming.id)) {
					next.push(incoming);
				}
			}
			return next;
		});
	}, [items]);

	useEffect(() => {
		const timers = exitTimersRef.current;
		return () => {
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
		};
	}, []);

	if (rendered.length === 0) return null;
	return (
		<div
			className="pointer-events-none fixed bottom-6 right-6 z-(--z-toast) flex w-80 flex-col gap-2 select-text"
			role="status"
			aria-live="polite"
		>
			{rendered.map((t) => {
				const Icon = ICONS[t.kind];
				return (
					<div
						key={t.id}
						data-exiting={t.exiting ? "true" : undefined}
						inert={Boolean(t.exiting) || undefined}
						onMouseEnter={() => pause(t.id)}
						onMouseLeave={() => resume(t.id)}
						className={clsx(
							"apple-toast flex items-start gap-2 rounded-xl hairline vibrancy-popover shadow-apple-modal px-3.5 py-2.5 text-xs",
							t.exiting ? "pointer-events-none" : "pointer-events-auto",
							TINT[t.kind],
						)}
					>
						<Icon size={14} className="mt-0.5 shrink-0" />
						<span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{t.text}</span>
						{t.action && (
							<button
								type="button"
								disabled={Boolean(t.exiting)}
								onClick={() => {
									t.action?.onClick();
									dismiss(t.id);
								}}
								className="shrink-0 rounded-full border border-[var(--border-divider)] px-2.5 py-0.5 font-medium text-[var(--accent)] transition-[background-color,transform] duration-150 ease-[var(--ease-out)] hover:bg-[var(--bg-hover)] active:scale-[0.97]"
							>
								{t.action.label}
							</button>
						)}
						<button
							type="button"
							disabled={Boolean(t.exiting)}
							title={tr("common.close")}
							aria-label={tr("components.closeNotice")}
							onClick={() => dismiss(t.id)}
							className="shrink-0 rounded p-0.5 text-neutral-500 transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] hover:bg-[var(--bg-hover)] hover:text-neutral-200 active:scale-[0.97]"
						>
							<X size={12} />
						</button>
					</div>
				);
			})}
		</div>
	);
}
