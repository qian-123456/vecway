import { Brain, ChevronRight } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { copyText } from "../../../core/lib/format";
import { Button, toast } from "../../../ui";
import { Markdown } from "../../../ui/Markdown";
import { thinkingLabel } from "../lib/turns";

/** Open state survives remounts of the row (window paging, live → persisted). */
const openKeys = new Set<string>();
const LIVE_TAIL_CHARS = 240;

/**
 * Collapsed preview text while reasoning streams: the newest two non-empty lines,
 * or the tail `maxChars` characters prefixed with `…` when a line is very long.
 */
export function livePreviewText(text: string, maxChars = LIVE_TAIL_CHARS): string {
	const lines = text
		.replace(/\r\n?/g, "\n")
		.replace(/\s+$/, "")
		.split("\n")
		.filter((l) => l.trim() !== "");
	if (lines.length === 0) return "";
	const tail = lines.slice(-2).join("\n");
	if (tail.length <= maxChars) return tail;
	const last = lines[lines.length - 1];
	if (last.length <= maxChars) return last;
	return `…${last.slice(last.length - maxChars)}`;
}

/**
 * One quiet line: 「已思考 12 秒 ›」, or a shimmering 「思考中」 with a 2-line rolling peek while it streams.
 * Tap expands the reasoning in a left-ruled block (full text, selectable).
 */
export const Thinking = memo(function Thinking({
	id,
	text,
	live,
	ms = null,
}: {
	id: string;
	text: string;
	live: boolean;
	ms?: number | null;
}) {
	const [open, setOpen] = useState(openKeys.has(id));
	const boxRef = useRef<HTMLDivElement>(null);
	const preview = live && !open ? livePreviewText(text) : "";

	useEffect(() => {
		const el = boxRef.current;
		if (!el || !open || !live) return;
		el.scrollTop = el.scrollHeight;
	}, [open, live, text]);

	if (!text.trim()) return null;
	const toggle = () => {
		if (open) openKeys.delete(id);
		else openKeys.add(id);
		setOpen(!open);
	};
	return (
		<div>
			<button
				type="button"
				aria-expanded={open}
				onClick={toggle}
				className="-mx-1.5 inline-flex min-h-9 max-w-full items-center gap-1.5 whitespace-nowrap rounded-m-sm px-1.5 py-1 text-left text-[13.5px] leading-6 text-m-text-quiet active:bg-m-surface-hover"
			>
				<Brain size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-m-text-quiet" />
				<span className={live ? "m-shimmer text-m-text-2" : "text-m-text-2"}>
					{live ? "思考中" : thinkingLabel(ms)}
				</span>
				<ChevronRight
					size={12}
					strokeWidth={1.75}
					aria-hidden
					className={`shrink-0 text-m-text-faint transition-transform duration-(--m-dur-fast) ${open ? "rotate-90" : ""}`}
				/>
			</button>
			{live && !open && preview && (
				<button
					type="button"
					onClick={toggle}
					aria-expanded={false}
					aria-label="展开思考过程"
					className="mt-px flex h-10 w-full flex-col justify-end overflow-hidden rounded text-left text-[12px] leading-5 text-m-text-quiet active:bg-m-surface-hover"
				>
					<span className="whitespace-pre-wrap break-words">{preview}</span>
				</button>
			)}
			{open && (
				<div
					ref={boxRef}
					className="m-selectable mt-0.5 mb-2 max-h-80 overflow-y-auto overscroll-contain break-words border-l border-m-border pl-3 text-[13px] leading-5 text-m-text-quiet"
				>
					<Markdown text={text} className="m-md-quiet" streaming={live} visualizeEnabled={false} />
					<div className="sticky bottom-0 flex justify-end gap-1.5 bg-m-bg/90 py-1 backdrop-blur-xs">
						<Button size="sm" variant="ghost" onClick={toggle}>收起思考</Button>
						<Button size="sm" variant="ghost" onClick={() => void copyText(text).then((ok) => toast(ok ? "已复制" : "复制失败", { kind: ok ? "success" : "error" }))}>复制</Button>
					</div>
				</div>
			)}
		</div>
	);
});
