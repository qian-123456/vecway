/**
 * Compact domain pill for inline model citations (`<cite-chip>`).
 * Single-source pills open the URL directly; multi-source pills show `+N` and
 * open a FloatingLayer popover listing every source link on click or hover.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FloatingLayer } from "../../components/FloatingLayer";
import { errMsg } from "../../lib/dialogs";
import { toast } from "../../lib/toast";
import { tNow } from "../../stores/language";
import { formatCitationHost, parseCitationUrls } from "./citations";

const HOVER_CLOSE_DELAY_MS = 180;

async function openCitationUrl(url: string): Promise<void> {
	try {
		await openUrl(url);
	} catch (err) {
		toast.error(tNow("components.openLinkFailed", { error: errMsg(err) }));
	}
}

/** Format a URL for the popover list: domain + readable path/query. */
function formatDisplayPath(url: string): { host: string; path: string } {
	try {
		const u = new URL(url);
		const host = u.hostname.replace(/^www\./i, "");
		const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`;
		return { host, path: rest || "/" };
	} catch {
		return { host: url, path: "" };
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
	const extraCount = urls.length - 1;
	const multi = extraCount > 0;

	const pillClass =
		"mx-0.5 inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--well-bg)] px-2 py-0.5 align-baseline text-[11px] font-medium leading-tight text-[var(--text-60)] whitespace-nowrap transition-colors hover:bg-[var(--ghost-hover)] hover:text-[var(--text)]";

	if (exportMode) {
		return (
			<span className={pillClass}>
				<span>{primaryHost}</span>
				{multi && <span className="text-[var(--text-40)]">+{extraCount}</span>}
			</span>
		);
	}

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				title={multi ? urls.join("\n") : urls[0]}
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
				<span>{primaryHost}</span>
				{multi && <span className="text-[var(--text-40)]">+{extraCount}</span>}
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
					className="w-80 max-w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--panel)] p-1.5 shadow-lg"
				>
					<div
						onMouseEnter={clearCloseTimer}
						onMouseLeave={scheduleClose}
						className="flex flex-col gap-0.5"
					>
						{urls.map((url) => {
							const { host, path } = formatDisplayPath(url);
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
									title={url}
									className="group/cite flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--ghost-hover)]"
								>
									<Globe
										size={13}
										className="mt-0.5 shrink-0 text-[var(--text-40)] group-hover/cite:text-[var(--text-60)]"
									/>
									<div className="min-w-0 flex-1">
										<div className="text-[12px] font-medium text-[var(--text)]">
											{host}
										</div>
										<div className="break-all text-[11px] leading-snug text-[var(--text-40)]">
											{path}
										</div>
									</div>
									<ExternalLink
										size={12}
										className="mt-0.5 shrink-0 text-[var(--text-30)] opacity-0 transition-opacity group-hover/cite:opacity-100"
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
