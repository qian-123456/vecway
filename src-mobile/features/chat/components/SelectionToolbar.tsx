import { Quote } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatUi } from "../ChatContext";
import { useKeyboardOpen } from "./ComposerToolbar";

/**
 * Single clean "引用" pill for a thread text selection, positioned safely above the composer dock
 * without competing with Safari's native Copy selection menu.
 */
export function SelectionToolbar({
	containerRef,
}: {
	containerRef: React.RefObject<HTMLElement | null>;
	sessionId?: string;
}) {
	const { controller } = useChatUi();
	const kbOpen = useKeyboardOpen();
	const [selectedText, setSelectedText] = useState<string | null>(null);
	const pending = useRef(0);

	const check = useCallback(() => {
		const s = window.getSelection();
		const container = containerRef.current;
		if (!s || s.isCollapsed || !s.rangeCount || !container) {
			setSelectedText(null);
			return;
		}
		const range = s.getRangeAt(0);
		const text = s.toString().trim();
		if (!text || !container.contains(range.commonAncestorContainer)) {
			setSelectedText(null);
			return;
		}
		const rect = range.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			setSelectedText(null);
			return;
		}
		setSelectedText(text);
	}, [containerRef]);

	useEffect(() => {
		const schedule = () => {
			window.clearTimeout(pending.current);
			pending.current = window.setTimeout(check, 120);
		};
		document.addEventListener("selectionchange", schedule);
		return () => {
			document.removeEventListener("selectionchange", schedule);
			window.clearTimeout(pending.current);
		};
	}, [check]);

	if (!selectedText) return null;

	const quote = () => {
		controller.stageAnnotation(selectedText);
		window.getSelection()?.removeAllRanges();
		setSelectedText(null);
	};

	return createPortal(
		<div
			role="toolbar"
			aria-label="引用选中的文字"
			style={{
				bottom: kbOpen ? "calc(var(--m-kb, 0px) + 108px)" : "calc(var(--m-safe-bottom) + 108px)",
			}}
			className="pointer-events-none fixed inset-x-0 z-(--z-banner) flex justify-center px-3"
		>
			<button
				type="button"
				onPointerDown={(e) => e.preventDefault()}
				onClick={quote}
				aria-label="引用选中文字"
				className="pointer-events-auto inline-flex min-h-10 items-center gap-1.5 rounded-m-pill border border-m-border bg-m-bg-elev px-4 text-m-sm font-medium whitespace-nowrap text-m-text shadow-m-pop active:bg-m-surface-hover"
			>
				<Quote size={15} strokeWidth={2} aria-hidden className="text-m-accent" />
				引用
			</button>
		</div>,
		document.body,
	);
}
