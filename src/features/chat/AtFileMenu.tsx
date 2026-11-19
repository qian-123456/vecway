/** Shared `@` workspace file-completion hook and floating menu for Composer and PromptComposer. */
import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";
import { FloatingLayer } from "../../components/FloatingLayer";
import { listWorkspaceFiles } from "../../lib/ipc";

export interface AtToken {
	query: string;
	start: number;
}

export function useAtFileMenu(
	cwd: string | null,
	text: string,
	cursorPos: number,
	scopeKey?: string,
) {
	const [atFiles, setAtFiles] = useState<string[] | null>(null);
	const atToken = useMemo<AtToken | null>(() => {
		const beforeCursor = text.slice(0, cursorPos);
		const m = /(?:^|\s)@([^\s@]*)$/.exec(beforeCursor);
		if (!m) return null;
		return { query: m[1], start: beforeCursor.length - m[1].length - 1 };
	}, [text, cursorPos]);

	// Esc / outside click dismisses the @ menu for the token it was opened on;
	// it stays closed until that token is gone (a new `@` reopens it).
	const [atDismissedStart, setAtDismissedStart] = useState<number | null>(null);
	useEffect(() => {
		if (!atToken && atDismissedStart !== null) setAtDismissedStart(null);
	}, [atToken, atDismissedStart]);

	const atMenu = useMemo(() => {
		if (!atToken || !atFiles || atDismissedStart === atToken.start) return [];
		const q = atToken.query.toLowerCase();
		return atFiles.filter((p) => !q || p.toLowerCase().includes(q)).slice(0, 10);
	}, [atToken, atFiles, atDismissedStart]);

	// The `@` file list belongs to one workspace: reload when scope or cwd changes.
	useEffect(() => {
		setAtFiles(null);
	}, [scopeKey, cwd]);

	useEffect(() => {
		if (atToken && atFiles === null) {
			if (!cwd) return;
			let cancelled = false;
			void listWorkspaceFiles(cwd)
				.then((files) => !cancelled && setAtFiles(files))
				.catch(() => !cancelled && setAtFiles([]));
			return () => {
				cancelled = true;
			};
		}
	}, [atToken !== null, atFiles === null, cwd]);

	const dismiss = () => {
		if (atToken) setAtDismissedStart(atToken.start);
	};

	const reset = () => {
		setAtFiles(null);
	};

	return { atToken, atMenu, dismiss, reset };
}

export function AtFileMenu({
	anchor,
	items,
	activeIndex,
	onSelect,
	onDismiss,
}: {
	anchor: HTMLElement | null;
	items: string[];
	activeIndex: number;
	onSelect: (path: string) => void;
	onDismiss: () => void;
}) {
	if (items.length === 0) return null;
	return (
		<FloatingLayer
			anchor={anchor}
			placement="top-start"
			offset={6}
			layer="popover"
			onDismiss={onDismiss}
			className="w-[min(calc(100vw-32px),600px)] max-h-64 overflow-x-hidden overflow-y-auto rounded-xl border-[var(--line,var(--border-divider))] !bg-[var(--bg-panel)] p-1"
		>
			{items.map((p, i) => (
				<button
					key={p}
					type="button"
					onMouseDown={(e) => {
						e.preventDefault();
						onSelect(p);
					}}
					className={clsx(
						"flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[12px] transition-colors",
						i === activeIndex
							? "bg-[var(--ghost-hover,var(--bg-hover))] text-[var(--text)]"
							: "text-[var(--text-60,var(--text-muted))] hover:bg-[var(--ghost-hover,var(--bg-hover))]",
					)}
				>
					<span className="min-w-0 break-all font-mono" title={p}>
						{p}
					</span>
				</button>
			))}
		</FloatingLayer>
	);
}
