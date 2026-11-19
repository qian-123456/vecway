/**
 * Compact domain pill for inline model citations (`<cite-chip>`).
 * Single-source pills open the URL directly; multi-source pills show `+N` and
 * open a FloatingLayer popover listing every source link on click or hover.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import clsx from "clsx";
import { ChevronDown, ExternalLink, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FloatingLayer } from "../../components/FloatingLayer";
import { errMsg } from "../../lib/dialogs";
import { toast } from "../../lib/toast";
import { tNow } from "../../stores/language";
import {
	formatCitationHost,
	formatCitationPreview,
	parseCitationUrls,
} from "./citations";

const HOVER_CLOSE_DELAY_MS = 180;

async function openCitationUrl(url: string): Promise<void> {
	try {
		await openUrl(url);
	} catch (err) {
		toast.error(tNow("components.openLinkFailed", { error: errMsg(err) }));
	}
}

export function CitationChip({
	urls,
	exportMode = false,
}: {
	urls: readonly string[];
	exportMode?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const closeTimerRef = useRef<number | null>(null);

	const clearCloseTimer = () => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	};

	const scheduleClose = () => {
		clearCloseTimer();
		closeTimerRef.current = window.setTimeout(() => {
			setOpen(false);
		}, HOVER_CLOSE_DELAY_MS);
	};

	useEffect(() => clearCloseTimer, []);

	if (urls.length === 0) return null;

	const primaryHost = formatCitationHost(urls[0]);
	const multi = urls.length > 1;

	const pillClass = clsx(
		"mx-0.5 inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--well-bg)] px-2 py-0.5 align-baseline text-[11px] font-medium leading-[1.35] text-[var(--text-60)] whitespace-nowrap shadow-[0_1px_1px_rgba(0,0,0,0.03)] transition-colors hover:bg-[var(--ghost-hover)] hover:text-[var(--text)]",
		open && "bg-[var(--ghost-hover)] text-[var(--text)]",
	);

	const pillContent = (
		<>
			<Globe size={11} className="shrink-0 text-[var(--text-40)]" />
			<span>{primaryHost}</span>
			{multi && (
				<span className="rounded-full bg-[var(--ghost-hover)] px-1.5 py-px text-[10px] font-semibold leading-none text-[var(--text-50)]">
					{urls.length}
				</span>
			)}
			{multi && (
				<ChevronDown
					size={11}
					className={clsx(
						"shrink-0 text-[var(--text-40)] transition-transform duration-150",
						open && "rotate-180",
					)}
				/>
			)}
		</>
	);

	if (exportMode) {
		return <span className={pillClass}>{pillContent}</span>;
	}

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				title={multi ? undefined : urls[0]}
				aria-expanded={multi ? open : undefined}
				aria-haspopup={multi ? "dialog" : undefined}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					clearCloseTimer();
					if (!multi) {
						void openCitationUrl(urls[0]);
						return;
					}
					setOpen((prev) => !prev);
				}}
				onMouseEnter={() => {
					if (!multi) return;
					clearCloseTimer();
					setOpen(true);
				}}
				onMouseLeave={() => {
					if (!multi) return;
					scheduleClose();
				}}
				className={pillClass}
			>
				{pillContent}
			</button>

			{multi && open && (
				<FloatingLayer
					anchor={triggerRef.current}
					placement="bottom-start"
					offset={6}
					layer="popover"
					ignoreRefs={[triggerRef]}
					onDismiss={() => {
						clearCloseTimer();
						setOpen(false);
					}}
					className="w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow-xl"
				>
					<div
						onMouseEnter={clearCloseTimer}
						onMouseLeave={scheduleClose}
						className="flex max-h-72 flex-col gap-0.5 overflow-y-auto p-1.5"
					>
						{urls.map((url, idx) => {
							const { title } = formatCitationPreview(url);
							return (
								<button
									key={url}
									type="button"
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										clearCloseTimer();
										setOpen(false);
										void openCitationUrl(url);
									}}
									className="group/cite flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--ghost-hover)]"
								>
									<span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--well-bg)] text-[10px] font-semibold text-[var(--text-50)]">
										{idx + 1}
									</span>
									<div className="min-w-0 flex-1">
										<div className="text-[12.5px] font-medium leading-snug text-[var(--text)]">
											{title}
										</div>
										<div className="mt-0.5 truncate text-[11px] text-[var(--text-40)]">
											{url}
										</div>
									</div>
									<ExternalLink
										size={12}
										className="mt-1 shrink-0 text-[var(--text-30)] opacity-0 transition-opacity group-hover/cite:opacity-100"
									/>
								</button>
							);
						})}
					</div>
				</FloatingLayer>
			)}
		</>
	);
}

/** Markdown component for `<cite-chip>`. */
export function MarkdownCitationChip(props: {
	"data-cite-urls"?: string;
	dataCiteUrls?: string;
}) {
	const raw = props["data-cite-urls"] ?? props.dataCiteUrls;
	const urls = parseCitationUrls(raw);
	return <CitationChip urls={urls} />;
}
