import { ArrowUp, Copy, MessageSquareQuote, MessagesSquare, TextSelect, X } from "lucide-react";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyText } from "../../../core/lib/format";
import { toast } from "../../../ui";
import { useRightDrawer } from "../../panels/rightDrawerStore";
import { ChatCtx } from "../ChatContext";

const EDGE_PAD = 12;
const ANCHOR_GAP = 10;
const COMMENT_MAX_HEIGHT = 120;

type TargetMode = "main" | "sidechat";

interface SelectedInfo {
	text: string;
	rect: DOMRect;
	range: Range;
}

export interface SelectionToolbarProps {
	containerRef: React.RefObject<HTMLElement | null>;
	sessionId?: string;
	inSideChat?: boolean;
	onAnnotate?: (quote: string, comment?: string) => void;
}

function clearNativeSelection(container: HTMLElement | null): void {
	const sel = window.getSelection();
	if (!sel || sel.isCollapsed) return;
	if (!container || (sel.anchorNode && container.contains(sel.anchorNode))) {
		sel.removeAllRanges();
	}
}

/**
 * Selection-anchored floating bubble for chat messages:
 * Row 1: 批注 | 批注到辅助对话 (when outside side chat and sessionId exists)
 * Row 2: 复制 | 全选
 * Clicking an annotate action expands an inline comment box anchored to the selection.
 */
export function SelectionToolbar({
	containerRef,
	sessionId,
	inSideChat = false,
	onAnnotate,
}: SelectionToolbarProps) {
	const chatUi = useContext(ChatCtx);
	const [selected, setSelected] = useState<SelectedInfo | null>(null);
	const [target, setTarget] = useState<TargetMode | null>(null);
	const [draft, setDraft] = useState("");
	const [pos, setPos] = useState<{ left: number; top: number }>({ left: EDGE_PAD, top: EDGE_PAD });

	const bubbleRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const pendingTimer = useRef(0);
	const selectedRef = useRef<SelectedInfo | null>(null);
	selectedRef.current = selected;
	const commentingRef = useRef(false);
	commentingRef.current = target !== null;

	const close = useCallback(() => {
		clearNativeSelection(containerRef.current);
		setSelected(null);
		setTarget(null);
		setDraft("");
	}, [containerRef]);

	const check = useCallback(() => {
		if (commentingRef.current) return;
		const s = window.getSelection();
		const container = containerRef.current;
		if (!s || s.isCollapsed || !s.rangeCount || !container) {
			setSelected(null);
			return;
		}
		const range = s.getRangeAt(0);
		const text = s.toString().trim();
		if (!text || !container.contains(range.commonAncestorContainer)) {
			setSelected(null);
			return;
		}
		const rect = range.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			setSelected(null);
			return;
		}
		setSelected({ text, rect, range: range.cloneRange() });
	}, [containerRef]);

	useEffect(() => {
		const schedule = () => {
			if (commentingRef.current) return;
			window.clearTimeout(pendingTimer.current);
			pendingTimer.current = window.setTimeout(check, 100);
		};
		document.addEventListener("selectionchange", schedule);
		return () => {
			document.removeEventListener("selectionchange", schedule);
			window.clearTimeout(pendingTimer.current);
		};
	}, [check]);

	const hasSelection = selected !== null;
	useEffect(() => {
		if (!hasSelection) return;
		const onScroll = () => {
			const cur = selectedRef.current;
			if (!cur) return;
			const nextRect = cur.range.getBoundingClientRect();
			if (cur.range.collapsed || (nextRect.width === 0 && nextRect.height === 0)) return;
			setSelected((prev) => (prev ? { ...prev, rect: nextRect } : prev));
		};
		window.addEventListener("scroll", onScroll, { capture: true, passive: true });
		return () => window.removeEventListener("scroll", onScroll, true);
	}, [hasSelection]);

	useEffect(() => {
		if (target === null) return;
		const onPointerDown = (e: PointerEvent) => {
			if (bubbleRef.current?.contains(e.target as Node)) return;
			close();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				close();
			}
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, [target, close]);

	useEffect(() => {
		if (target !== null) {
			inputRef.current?.focus();
		}
	}, [target]);

	useEffect(() => {
		const ta = inputRef.current;
		if (target === null || !ta) return;
		ta.style.height = "auto";
		ta.style.height = `${Math.min(ta.scrollHeight, COMMENT_MAX_HEIGHT)}px`;
		ta.style.overflowY = ta.scrollHeight > COMMENT_MAX_HEIGHT ? "auto" : "hidden";
	}, [target, draft]);

	const computePosition = useCallback(() => {
		const cur = selectedRef.current;
		if (!cur) return;
		const vw = window.innerWidth || 390;
		const vh = window.innerHeight || 844;
		const vv = window.visualViewport;
		const visTop = (vv?.offsetTop ?? 0) + EDGE_PAD;
		const visBottom = (vv ? vv.offsetTop + vv.height : vh) - EDGE_PAD;

		const el = bubbleRef.current;
		const fallbackW = target !== null ? Math.min(312, vw - EDGE_PAD * 2) : 252;
		const fallbackH = target !== null ? 148 : 84;
		const bubbleW = el?.offsetWidth || fallbackW;
		const bubbleH = el?.offsetHeight || fallbackH;

		const rect = cur.rect;
		const spaceAbove = rect.top - visTop - ANCHOR_GAP;
		const spaceBelow = visBottom - rect.bottom - ANCHOR_GAP;
		const placeAbove = spaceAbove >= bubbleH || (spaceAbove >= 48 && spaceAbove >= spaceBelow);
		const rawTop = placeAbove ? rect.top - ANCHOR_GAP - bubbleH : rect.bottom + ANCHOR_GAP;
		const top = Math.max(visTop, Math.min(rawTop, visBottom - bubbleH));

		const rawLeft = rect.left + rect.width / 2 - bubbleW / 2;
		const left = Math.max(EDGE_PAD, Math.min(rawLeft, vw - EDGE_PAD - bubbleW));

		setPos({ left, top });
	}, [target]);

	useLayoutEffect(() => {
		if (!selected) return;
		computePosition();
		const raf = requestAnimationFrame(computePosition);
		window.addEventListener("resize", computePosition);
		window.visualViewport?.addEventListener("resize", computePosition);
		window.visualViewport?.addEventListener("scroll", computePosition);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("resize", computePosition);
			window.visualViewport?.removeEventListener("resize", computePosition);
			window.visualViewport?.removeEventListener("scroll", computePosition);
		};
	}, [selected, target, draft, computePosition]);

	if (!selected) return null;

	const canSideChat = !inSideChat && Boolean(sessionId);

	const openComment = (mode: TargetMode) => {
		setDraft("");
		setTarget(mode);
	};

	const handleCopy = () => {
		const text = selected.text;
		close();
		void copyText(text).then((ok) => {
			toast(ok ? "已复制" : "复制失败", { kind: ok ? "success" : "error" });
		});
	};

	const handleSelectAll = () => {
		const container = containerRef.current;
		if (!container) return;
		const node = selected.range.commonAncestorContainer;
		const anchorEl = node instanceof Element ? node : node.parentElement;
		const candidate = anchorEl?.closest<HTMLElement>(".m-selectable, [data-message-item-id], [id^='msg-']");
		const selectRoot = candidate && container.contains(candidate) ? candidate : container;

		const nextRange = document.createRange();
		nextRange.selectNodeContents(selectRoot);
		const s = window.getSelection();
		if (s) {
			s.removeAllRanges();
			s.addRange(nextRange);
		}
		const nextText = (s?.toString() || selectRoot.textContent || selected.text).trim();
		const nextRect = nextRange.getBoundingClientRect();
		const validRect = nextRect.width > 0 || nextRect.height > 0 ? nextRect : selected.rect;
		if (nextText) {
			setSelected({ text: nextText, rect: validRect, range: nextRange.cloneRange() });
		}
	};

	const submitComment = () => {
		const comment = draft.trim() || undefined;
		if (target === "sidechat" && sessionId) {
			useRightDrawer.getState().openSidechatWithAnnotation(sessionId, {
				quote: selected.text,
				comment,
			});
		} else if (onAnnotate) {
			onAnnotate(selected.text, comment);
		} else {
			chatUi?.controller.stageAnnotation(selected.text, comment);
		}
		close();
	};

	const preventSteal = (e: React.PointerEvent) => {
		e.preventDefault();
	};

	return createPortal(
		<div
			ref={bubbleRef}
			role={target !== null ? "dialog" : "toolbar"}
			aria-label={target !== null ? "添加批注" : "选中文字操作"}
			style={{
				left: `${pos.left}px`,
				top: `${pos.top}px`,
				maxWidth: `calc(100vw - ${EDGE_PAD * 2}px)`,
			}}
			className="fixed z-(--z-modal) overflow-hidden rounded-m-lg border border-m-border bg-m-bg-elev text-m-text shadow-m-pop"
		>
			{target !== null ? (
				<div className="flex w-[min(312px,calc(100vw-24px))] flex-col gap-2 p-2.5">
					<div className="flex items-start justify-between gap-2">
						<div className="min-w-0 flex-1 space-y-1">
							<div className="text-m-xs font-medium whitespace-nowrap text-m-accent">
								{target === "sidechat" ? "批注到辅助对话" : "批注"}
							</div>
							<p className="m-0 line-clamp-2 border-l-2 border-m-border pl-2 text-m-xs text-m-text-3">
								{selected.text}
							</p>
						</div>
						<button
							type="button"
							onClick={close}
							aria-label="取消批注"
							className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-m-text-3 active:bg-m-surface-hover active:text-m-text"
						>
							<X size={14} strokeWidth={2} />
						</button>
					</div>
					<div className="flex items-end gap-1.5 rounded-m-md border border-m-border bg-m-surface px-2.5 py-1.5">
						<textarea
							ref={inputRef}
							rows={1}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
									e.preventDefault();
									submitComment();
								}
							}}
							placeholder="添加批注（可选）..."
							aria-label="添加批注"
							className="min-h-7 min-w-0 flex-1 resize-none bg-transparent py-1 text-m-sm leading-[1.4] text-m-text outline-none placeholder:text-m-text-3"
						/>
						<button
							type="button"
							onClick={submitComment}
							aria-label="确认批注"
							className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-m-text text-m-bg active:scale-95"
						>
							<ArrowUp size={14} strokeWidth={2.25} />
						</button>
					</div>
				</div>
			) : (
				<div className="flex flex-col">
					<div className="flex items-center">
						<button
							type="button"
							onPointerDown={preventSteal}
							onClick={() => openComment("main")}
							className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 px-3.5 text-m-sm font-medium whitespace-nowrap text-m-text active:bg-m-surface-hover"
						>
							<MessageSquareQuote size={14} strokeWidth={2} aria-hidden className="shrink-0 text-m-accent" />
							批注
						</button>
						{canSideChat && (
							<>
								<span aria-hidden className="h-4 w-px shrink-0 bg-m-border" />
								<button
									type="button"
									onPointerDown={preventSteal}
									onClick={() => openComment("sidechat")}
									className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 px-3.5 text-m-sm font-medium whitespace-nowrap text-m-text active:bg-m-surface-hover"
								>
									<MessagesSquare size={14} strokeWidth={2} aria-hidden className="shrink-0 text-m-accent" />
									批注到辅助对话
								</button>
							</>
						)}
					</div>
					<div className="h-px bg-m-border" />
					<div className="flex items-center">
						<button
							type="button"
							onPointerDown={preventSteal}
							onClick={handleCopy}
							className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 px-3.5 text-m-xs font-medium whitespace-nowrap text-m-text-2 active:bg-m-surface-hover active:text-m-text"
						>
							<Copy size={13} strokeWidth={2} aria-hidden className="shrink-0" />
							复制
						</button>
						<span aria-hidden className="h-4 w-px shrink-0 bg-m-border" />
						<button
							type="button"
							onPointerDown={preventSteal}
							onClick={handleSelectAll}
							className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 px-3.5 text-m-xs font-medium whitespace-nowrap text-m-text-2 active:bg-m-surface-hover active:text-m-text"
						>
							<TextSelect size={13} strokeWidth={2} aria-hidden className="shrink-0" />
							全选
						</button>
					</div>
				</div>
			)}
		</div>,
		document.body,
	);
}
