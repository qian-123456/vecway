import { ArrowUp, ChevronDown, Maximize2, Mic, Plus, Square } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { BottomSheet, Button, Spinner } from "../../../ui";
import { desktopThinkingLabel, parseModelRef, shortModel } from "../lib/models";
import { ContextIndicator } from "./ContextIndicator";
import { useVoiceInput } from "./useVoiceInput";

/** Imperative handle of the uncontrolled textarea. */
export interface ComposerApi {
	get(): string;
	set(text: string, focus?: boolean): void;
	focus(): void;
	clear(): void;
	/** Insert at the caret (voice transcript, file references). */
	insert(text: string): void;
}

/** One 24px text line plus pt-3 (12px) and pb-1.5 (6px). */
const LINE_PX = 42;
const MAX_INPUT = "calc(var(--m-vh, 100dvh) * 0.4 - 64px)";

/**
 * Desktop-style stable 2-row composer card:
 * - Top row: full-width auto-growing textarea only.
 * - Bottom toolbar row (always mounted, never jumps/unmounts on keyboard open/close):
 *   Left: [+], [Model ⌄], [Thinking ⌄], extra chips; Right: Context, [Mic], [Stop?], [Send].
 */
export function ComposerCapsule({
	apiRef,
	initialText = "",
	placeholder,
	working = false,
	hasExtra = false,
	busy = false,
	top,
	onPlus,
	onSend,
	onStop,
	onInput,
	onSync,
	onUnmount,
	onCanSendChange,
	externalStopBar = false,
	onFocusChange,
	model,
	thinking,
	onModel,
	onThinking,
	contextText,
	contextPercent,
	contextToneClass = "text-m-text-3",
	onContext,
	extraLeft,
}: {
	apiRef?: RefObject<ComposerApi | null>;
	initialText?: string;
	placeholder: string;
	/** A run is in progress: stop remains available alongside the independent send action. */
	working?: boolean;
	/** Something other than text can be sent (attachments). */
	hasExtra?: boolean;
	/** Sending is in flight: disables send. */
	busy?: boolean;
	/** Content inside the capsule above the text (attachment tiles). */
	top?: ReactNode;
	onPlus: () => void;
	onSend: (text: string) => void;
	onStop?: () => void;
	/** Every input event (persisting, draft activity). Cheap: no layout, no React state. */
	onInput?: () => void;
	/** Frame-coalesced, never mid-composition: the current value (slash detection). */
	onSync?: (value: string) => void;
	/** Final text when the capsule unmounts (save the unsent draft). */
	onUnmount?: (value: string) => void;
	/** Notifies parent when sendable state changes (used by outer ear bar for Stop placement). */
	onCanSendChange?: (canSend: boolean) => void;
	/** Parent renders an external Stop control when `working && canSend`. */
	externalStopBar?: boolean;
	onFocusChange?: (focused: boolean) => void;
	model?: string | null;
	thinking?: string | null;
	onModel?: (anchor?: HTMLElement | null) => void;
	onThinking?: (anchor?: HTMLElement | null) => void;
	contextText?: string | null;
	contextPercent?: number | null;
	contextToneClass?: string;
	onContext?: (ev?: MouseEvent<HTMLElement>) => void;
	extraLeft?: ReactNode;
}) {
	const ta = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	const raf = useRef(0);
	const [hasText, setHasText] = useState(() => initialText.trim() !== "");
	const [tall, setTall] = useState(false);
	const [expandOpen, setExpandOpen] = useState(false);
	const [expandDraft, setExpandDraft] = useState("");
	const cb = useRef({ onSync, onInput, onUnmount, onCanSendChange });
	cb.current = { onSync, onInput, onUnmount, onCanSendChange };

	/** Size textarea at its exact displayed width. */
	const measure = useCallback(() => {
		const el = ta.current;
		if (!el || composing.current) return;
		const scrollTop = el.scrollTop;
		el.style.height = "0px";
		const scrollH = el.scrollHeight;
		const nextH = Math.max(LINE_PX, scrollH);
		el.style.height = `${nextH}px`;
		el.scrollTop = scrollTop;
		setTall(nextH > LINE_PX + 18);
	}, []);

	/** One frame-coalesced pass; never change layout or sync drafts during IME composition. */
	const flush = useCallback(() => {
		raf.current = 0;
		const el = ta.current;
		if (!el || composing.current) return;
		setHasText(el.value.trim() !== "");
		cb.current.onSync?.(el.value);
		measure();
	}, [measure]);

	const schedule = useCallback(() => {
		if (!raf.current) raf.current = requestAnimationFrame(flush);
	}, [flush]);

	useLayoutEffect(() => {
		const el = ta.current;
		if (!el) return;
		el.value = initialText;
		flush();
		return () => {
			cancelAnimationFrame(raf.current);
			cb.current.onUnmount?.(el.value);
		};
		// initialText is the mount-time value only; later changes go through the api.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [flush]);

	useLayoutEffect(() => {
		measure();
		const el = ta.current;
		if (!el) return;
		let width = el.clientWidth;
		const observer = new ResizeObserver(() => {
			if (el.clientWidth === width) return;
			width = el.clientWidth;
			measure();
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [measure, top]);

	const insert = useCallback(
		(text: string) => {
			const el = ta.current;
			if (!el) return;
			const cur = el.value;
			const start = el.selectionStart ?? cur.length;
			const end = el.selectionEnd ?? cur.length;
			const before = cur.slice(0, start);
			const after = cur.slice(end);
			const pad = before && !/\s$/.test(before) ? " " : "";
			const next = `${before}${pad}${text}${after}`;
			el.value = next;
			const caret = before.length + pad.length + text.length;
			el.focus();
			el.setSelectionRange(caret, caret);
			composing.current = false;
			cb.current.onInput?.();
			flush();
		},
		[flush],
	);

	useLayoutEffect(() => {
		if (!apiRef) return;
		apiRef.current = {
			get: () => ta.current?.value ?? "",
			set: (text, focus) => {
				const t = ta.current;
				if (!t) return;
				t.value = text;
				if (focus) {
					t.focus();
					t.setSelectionRange(text.length, text.length);
				}
				composing.current = false;
				cb.current.onInput?.();
				flush();
			},
			focus: () => ta.current?.focus(),
			clear: () => {
				if (!ta.current) return;
				ta.current.value = "";
				cb.current.onInput?.();
				flush();
			},
			insert,
		};
		return () => {
			apiRef.current = null;
		};
	}, [apiRef, flush, insert]);

	const { recording, transcribing, toggleRecording } = useVoiceInput({ onTranscribed: insert });
	const canSend = (hasText || hasExtra) && !busy;
	const showPrimaryStop = working && onStop != null && !canSend;
	const showInlineStopBar = working && onStop != null && canSend && !externalStopBar;
	useEffect(() => {
		cb.current.onCanSendChange?.(canSend);
	}, [canSend]);
	const submit = () => {
		const text = ta.current?.value ?? "";
		// A stale second click on Send must never become an implicit Stop request.
		if (!busy && !composing.current && (text.trim() !== "" || hasExtra)) onSend(text);
	};

	const modelName = shortModel(model ?? "") || "默认模型";
	const effectiveThinking = thinking || parseModelRef(model)?.thinking || null;
	const thinkName = desktopThinkingLabel(effectiveThinking);
	const hasModel = onModel != null || model != null;
	const hasThinking = onThinking != null || thinking != null;
	const applyExpand = (nextText: string) => {
		const el = ta.current;
		if (!el) return;
		el.value = nextText;
		composing.current = false;
		cb.current.onInput?.();
		flush();
	};
	const openExpand = () => {
		setExpandDraft(ta.current?.value ?? "");
		setExpandOpen(true);
	};

	return (
		<>
			{showInlineStopBar && (
				<div className="mb-1.5 flex items-center justify-end px-2.5 text-m-xs">
					<button
						type="button"
						aria-label="停止"
						onClick={onStop}
						className="m-press rounded-full bg-m-danger-bg px-2.5 py-0.5 font-medium whitespace-nowrap text-m-danger active:opacity-80"
					>
						停止
					</button>
				</div>
			)}
			<div className="relative flex flex-col rounded-(--m-composer-radius) border border-m-composer-border bg-m-composer-bg shadow-m-composer backdrop-blur-xl transition-[border-color,background-color] duration-(--m-dur-fast) focus-within:border-m-border-strong">
				{top != null && <div className="max-h-[26vh] overflow-y-auto overscroll-contain p-2.5 pb-0">{top}</div>}
				<div className="relative flex items-start">
					<textarea
						ref={ta}
						rows={1}
						enterKeyHint="enter"
						placeholder={placeholder}
						aria-label="消息输入框"
						onFocus={() => onFocusChange?.(true)}
						onBlur={() => onFocusChange?.(false)}
						onInput={() => {
							if (!composing.current) {
								onInput?.();
								schedule();
							}
						}}
						onCompositionStart={() => {
							composing.current = true;
						}}
						onCompositionEnd={() => {
							composing.current = false;
							onInput?.();
							schedule();
						}}
						onKeyDown={(e) => {
							const native = e.nativeEvent as KeyboardEvent & { inputType?: string };
							// Native mobile line breaks and IME commits are never message submissions.
							if (e.key !== "Enter" || e.shiftKey || composing.current || native.isComposing || e.keyCode === 229 || native.inputType === "insertLineBreak") return;
							const hardware = e.metaKey || e.ctrlKey || (typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches);
							if (!hardware || e.altKey) return;
							e.preventDefault();
							if (!e.repeat) submit();
						}}
						style={{ maxHeight: MAX_INPUT, outline: "none", boxShadow: "none" }}
						className={`m-selectable min-h-[42px] w-full min-w-0 resize-none bg-transparent pt-3 pb-1.5 pl-4 text-m-md leading-6 text-m-text outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 placeholder:text-m-text-3 ${hasText || tall ? "pr-10" : "pr-4"}`}
					/>
					{(hasText || tall) && (
						<button
							type="button"
							aria-label="全屏编辑消息"
							onClick={openExpand}
							className="m-press absolute top-1.5 right-1.5 flex h-9 w-9 items-center justify-center rounded-full text-m-text-3 active:bg-m-surface-hover active:text-m-text"
						>
							<Maximize2 size={14} strokeWidth={1.85} />
						</button>
					)}
				</div>

				{/* Bottom Toolbar Row: left (+, [model], [thinking], extraLeft), right (context ring, mic, single primary circle) */}
				<div className="flex items-center justify-between gap-1.5 px-2.5 pt-0.5 pb-2 text-xs">
					<div className="flex min-w-0 flex-1 items-center gap-0.5">
						<button
							type="button"
							aria-label="添加"
							onClick={onPlus}
							className="-m-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
						>
							<span className="flex h-8 w-8 items-center justify-center rounded-full text-m-text-2 transition-[background-color,color,transform] duration-(--m-dur-press) ease-m hover:bg-m-surface hover:text-m-text active:scale-95 active:bg-m-surface-2">
								<Plus size={18} strokeWidth={2} />
							</span>
						</button>

						{hasModel && (
							<button
								type="button"
								aria-label={`当前模型：${modelName}，点击切换`}
								onClick={(e) => onModel?.(e.currentTarget)}
								disabled={!onModel}
								className="-my-1.5 flex min-h-11 min-w-0 flex-initial items-center gap-1 rounded-m-sm px-2 text-left transition-[background-color,transform] duration-(--m-dur-press) ease-m hover:bg-m-surface/70 active:scale-[0.98] active:bg-m-surface-2 disabled:cursor-default disabled:active:scale-100"
							>
								<span className="min-w-0 truncate text-[12.5px] font-medium text-m-text">
									{modelName}
								</span>
								{onModel && <ChevronDown size={12} className="shrink-0 text-m-text-3" aria-hidden />}
							</button>
						)}

						{hasThinking && (
							<button
								type="button"
								aria-label={`思考强度：${thinkName}，点击切换`}
								onClick={(e) => (onThinking ?? onModel)?.(e.currentTarget)}
								disabled={!onThinking && !onModel}
								className="-my-1.5 flex min-h-11 shrink-0 items-center gap-0.5 rounded-m-sm px-1.5 text-left transition-[background-color,transform] duration-(--m-dur-press) ease-m hover:bg-m-surface/70 active:scale-[0.98] active:bg-m-surface-2 disabled:cursor-default disabled:active:scale-100"
							>
								<span className="text-[12px] whitespace-nowrap text-m-text-2">
									{thinkName}
								</span>
								<ChevronDown size={12} className="shrink-0 text-m-text-3" aria-hidden />
							</button>
						)}

						{extraLeft}
					</div>

					<div className="flex shrink-0 items-center gap-1">
						{contextText && (
							<button
								type="button"
								aria-label={`上下文用量：${contextText}`}
								title={`上下文用量：${contextText}`}
								onClick={onContext}
								disabled={!onContext}
								className={`-mx-1 -my-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-60 ${contextToneClass}`}
							>
								<span className="flex h-8 w-8 items-center justify-center rounded-full transition-[background-color,transform] duration-(--m-dur-press) ease-m hover:bg-m-surface active:scale-95 active:bg-m-surface-2">
									<ContextIndicator text={contextText} percent={contextPercent} compact />
								</span>
							</button>
						)}

						<button
							type="button"
							aria-label={recording ? "停止录音" : "语音输入"}
							aria-pressed={recording}
							disabled={transcribing}
							onClick={() => void toggleRecording()}
							className="-mx-1 -my-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
						>
							<span
								className={`flex h-8 w-8 items-center justify-center rounded-full transition-[background-color,color,transform] duration-(--m-dur-press) ease-m ${
									recording
										? "m-pulse bg-m-danger text-white"
										: "text-m-text-2 hover:bg-m-surface hover:text-m-text active:scale-95 active:bg-m-surface-2"
								}`}
							>
								{transcribing ? <Spinner size={15} /> : recording ? <Square size={12} fill="currentColor" /> : <Mic size={17} />}
							</span>
						</button>

						{showPrimaryStop ? (
							<button
								key="stop"
								type="button"
								aria-label="停止"
								onClick={onStop}
								className="-my-1.5 -mr-1.5 -ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
							>
								<span className="flex h-8 w-8 items-center justify-center rounded-full bg-m-text text-m-bg transition-transform duration-(--m-dur-press) ease-m active:scale-95">
									<Square size={11} fill="currentColor" />
								</span>
							</button>
						) : (
							<button
								key="send"
								type="button"
								aria-label="发送"
								disabled={!canSend}
								onClick={submit}
								className="-my-1.5 -mr-1.5 -ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed"
							>
								<span
									className={`flex h-8 w-8 items-center justify-center rounded-full transition-[background-color,color,transform,opacity] duration-(--m-dur-press) ease-m ${
										canSend
											? "cursor-pointer bg-m-text text-m-bg shadow-xs active:scale-95"
											: "bg-m-surface-2 text-m-text-3"
									}`}
								>
									{busy ? <Spinner size={15} /> : <ArrowUp size={16} strokeWidth={2.25} />}
								</span>
							</button>
						)}
					</div>
				</div>
			</div>

			<BottomSheet
				open={expandOpen}
				onClose={() => {
					applyExpand(expandDraft);
					setExpandOpen(false);
				}}
				title="编辑消息"
				fullHeight
				footer={
					<div className="flex items-center gap-2">
						<Button
							className="flex-1"
							onClick={() => setExpandOpen(false)}
						>
							取消
						</Button>
						<Button
							variant="tonal"
							className="flex-1"
							onClick={() => {
								applyExpand(expandDraft);
								setExpandOpen(false);
							}}
						>
							完成
						</Button>
						<Button
							variant="primary"
							className="flex-1"
							disabled={busy || (expandDraft.trim() === "" && !hasExtra)}
							onClick={() => {
								const v = expandDraft;
								applyExpand(v);
								setExpandOpen(false);
								if (!busy && (v.trim() !== "" || hasExtra)) onSend(v);
							}}
						>
							发送
						</Button>
					</div>
				}
			>
				<div className="flex h-full flex-col px-4 pt-1 pb-4">
					<textarea
						autoFocus
						value={expandDraft}
						onChange={(e) => setExpandDraft(e.target.value)}
						placeholder={placeholder}
						aria-label="全屏编辑消息内容"
						className="m-selectable min-h-0 w-full flex-1 resize-none rounded-m-lg border border-m-border bg-m-surface px-3.5 py-3 text-m-md leading-6 text-m-text outline-none focus:border-m-border-strong placeholder:text-m-text-3"
					/>
				</div>
			</BottomSheet>
		</>
	);
}
