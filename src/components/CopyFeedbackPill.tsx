import { Check } from "lucide-react";
import { useLayoutEffect, useRef, useState, useEffect } from "react";
import {
	computeCopyPillPosition,
	type CopyPillRect,
	installGlobalCopyFeedbackListener,
	useCopyFeedback,
} from "../lib/copyFeedback";
import { useT } from "../stores/language";
import { prefersReducedMotion, usePresence } from "../lib/motion";
import { usableViewport, Z_LAYER } from "./FloatingLayer";

/** Collect bounding boxes of currently visible floating menus/selection bubbles to avoid overlapping them. */
function collectVisibleMenuObstacles(): CopyPillRect[] {
	const out: CopyPillRect[] = [];
	for (const el of document.querySelectorAll<HTMLElement>('[data-layer="menu"]')) {
		const style = getComputedStyle(el);
		if (style.visibility === "hidden" || style.display === "none") continue;
		const r = el.getBoundingClientRect();
		if (r.width > 0 && r.height > 0) {
			out.push({
				left: r.left,
				top: r.top,
				right: r.right,
				bottom: r.bottom,
				width: r.width,
				height: r.height,
			});
		}
	}
	return out;
}

/**
 * Compact copy-feedback pill shown briefly right beside the copied text
 * selection or clicked button, avoiding overlap with the annotation bubble.
 * Mount once at the app root.
 */
const COPY_PILL_EXIT_MS = 150;

/**
 * Compact copy-feedback pill shown briefly right beside the copied text
 * selection or clicked button, avoiding overlap with the annotation bubble.
 * Mount once at the app root.
 */
export function CopyFeedbackPill() {
	const { t } = useT();
	const current = useCopyFeedback((s) => s.current);
	const isOpen = Boolean(current);
	const { present, exiting } = usePresence(isOpen, COPY_PILL_EXIT_MS);
	const lastItemRef = useRef(current);
	if (current) lastItemRef.current = current;
	const item = current ?? (present ? lastItemRef.current : null);

	const pillRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

	useEffect(() => installGlobalCopyFeedbackListener(), []);

	useLayoutEffect(() => {
		if (!present) {
			setPos(null);
			return;
		}
		const el = pillRef.current;
		if (!current || !el) return;
		const width = el.offsetWidth;
		const height = el.offsetHeight;
		const next = computeCopyPillPosition(
			current.anchor,
			{ width, height },
			usableViewport(),
			collectVisibleMenuObstacles(),
		);
		setPos(next);
	}, [current, present]);

	if (!present || !item || (!isOpen && prefersReducedMotion())) return null;

	return (
		<div
			ref={pillRef}
			className="pointer-events-none fixed"
			style={{
				zIndex: Z_LAYER.toast,
				left: pos?.left ?? -9999,
				top: pos?.top ?? -9999,
				visibility: pos ? "visible" : "hidden",
			}}
			role="status"
			aria-live="polite"
		>
			<div
				data-exiting={exiting ? "true" : undefined}
				className="copy-feedback-pill flex items-center gap-1.5 rounded-full hairline vibrancy-popover shadow-apple-modal px-2.5 py-1 text-[11px] leading-none text-[var(--text)]"
			>
				<Check size={12} strokeWidth={2.5} className="shrink-0 text-[var(--status-success)]" />
				<span className="whitespace-nowrap font-medium">
					{item.label ?? t("common.copied")}
				</span>
			</div>
		</div>
	);
}
