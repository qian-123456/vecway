/**
 * Right-panel file preview: one tab per opened file (see `stores/filePreview`).
 * Text files open read-only in 预览 and can switch to 编辑 (CodeMirror, ⌘S);
 * images render inline. Markdown previews reuse the chat renderer, so paths
 * inside the document stay clickable.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { ExternalLink, FileText, FolderOpen, Maximize2, Minimize2, RefreshCw, Save } from "lucide-react";
import React, { Suspense, useEffect, useRef, useState } from "react";
import { importImageFile } from "../../lib/ipc";
import { copyText, errMsg } from "../../lib/dialogs";
import { basename, shortPath } from "../../lib/paths";
import { useHomeDir } from "../../lib/hooks";
import { toast } from "../../lib/toast";
import { previewKind } from "../../lib/fileLinks";
import { type FileTab, useFilePreview } from "../../stores/filePreview";
import { useUi } from "../../stores/ui";
import { SelectionToolbar } from "../chat/SelectionToolbar";
import { AnnotationMarkers } from "../chat/AnnotationMarkers";
import { Segmented } from "../../components/Segmented";
import { Markdown } from "../../components/Markdown";
import { MermaidBlock } from "../chat/MermaidBlock";
import { useFileBuffer } from "../editor/useFileBuffer";
import { useT } from "../../stores/language";
import { buildHtmlPreviewDoc, HTML_PREVIEW_SANDBOX, isHtmlPreviewPath, relayedExternalUrl } from "./htmlPreview";

const FileEditor = React.lazy(() => import("./FileEditor"));

function ExternalActions({ path, isHtml }: { path: string; isHtml?: boolean }) {
	const { t } = useT();
	const run = (fn: () => Promise<void>, what: string) => {
		void fn().catch((e: unknown) => toast.error(t("files.actionFailed", { action: what, error: errMsg(e) })));
	};
	const openLabel = isHtml ? t("files.openInBrowser") : t("files.systemOpen");
	return (
		<>
			<button
				type="button"
				onClick={() => run(() => openPath(path), t("files.actionOpen"))}
				title={isHtml ? t("files.openInBrowser") : t("files.openWithSystemDefault")}
				aria-label={openLabel}
				className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-neutral-300 transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
			>
				<ExternalLink size={13} className="shrink-0" />
				<span className="hidden @[440px]:inline">{openLabel}</span>
			</button>
			<button
				type="button"
				onClick={() => run(() => revealItemInDir(path), t("files.actionReveal"))}
				title={t("files.actionReveal")}
				aria-label={t("files.finder")}
				className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-neutral-300 transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
			>
				<FolderOpen size={13} className="shrink-0" />
				<span className="hidden @[440px]:inline">{t("files.finder")}</span>
			</button>
		</>
	);
}

function PathCopyButton({ path, displayPath }: { path: string; displayPath: string }) {
	const { t } = useT();
	return (
		<button
			type="button"
			onClick={() =>
				void copyText(path, { label: t("files.copiedPath") }).catch((e: unknown) =>
					toast.error(errMsg(e)),
				)
			}
			title={path}
			className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left font-mono text-[11px] text-[var(--text-40)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
		>
			{displayPath}
		</button>
	);
}

function MaximizeToggleButton() {
	const { t } = useT();
	const rightMaximized = useUi((s) => s.rightMaximized);
	const toggleRightMaximized = useUi((s) => s.toggleRightMaximized);
	const label = rightMaximized ? t("rightPanel.restorePanel") : t("rightPanel.maximizePanel");
	return (
		<button
			type="button"
			onClick={toggleRightMaximized}
			title={label}
			aria-label={label}
			className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-300 transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
		>
			{rightMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
		</button>
	);
}

function ImageBody({ path }: { path: string }) {
	const { t } = useT();
	const home = useHomeDir();
	const resolved = path.startsWith("~/") && home ? `${home.replace(/\/+$/, "")}${path.slice(1)}` : path;
	const [imagePath, setImagePath] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (path.startsWith("~/") && !home) return;
		let cancelled = false;
		setImagePath(null);
		setFailed(false);
		void importImageFile(resolved).then((stored) => {
			if (!cancelled) setImagePath(stored);
		}).catch(() => {
			if (!cancelled) setFailed(true);
		});
		return () => {
			cancelled = true;
		};
	}, [home, path, resolved]);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-divider)] px-2.5 py-1 text-[11px]">
				<PathCopyButton path={resolved} displayPath={shortPath(resolved, home)} />
				<div className="flex shrink-0 items-center gap-0.5">
					<MaximizeToggleButton />
					<ExternalActions path={resolved} />
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-auto p-3">
				{path.startsWith("~/") && !home ? (
					<div className="text-xs text-[var(--text-60)]">{t("files.cannotResolveTildePath", { path })}</div>
				) : failed ? (
					<div className="flex min-h-32 flex-col items-center justify-center gap-1 text-center text-xs text-[var(--text-60)]">
						<span>{t("components.imageLoadFailed")}</span>
						<span className="select-text break-all text-[var(--text-40)]">{resolved}</span>
					</div>
				) : !imagePath ? (
					<div className="flex min-h-32 items-center justify-center text-xs text-[var(--text-60)]">{t("files.loading")}</div>
				) : (
					<img
						src={convertFileSrc(imagePath)}
						alt={basename(path)}
						onError={() => setFailed(true)}
						className="mx-auto max-w-full rounded-lg border border-[var(--line)] object-contain"
					/>
				)}
			</div>
		</div>
	);
}

function TextBody({ tab }: { tab: FileTab }) {
	const { t } = useT();
	const buffer = useFileBuffer(tab.path);
	const { saved, draft, setDraft, error, external, saving, dirty } = buffer;
	const setMode = useFilePreview((s) => s.setMode);
	const home = useHomeDir();
	const sessionId = useUi((s) => s.selectedSessionId);
	const previewRef = useRef<HTMLDivElement>(null);
	const isMarkdown = /\.(md|markdown|mdx)$/i.test(tab.path);
	const isMermaid = /\.mmd$/i.test(tab.path);
	const isHtml = isHtmlPreviewPath(tab.path);
	const iframeRef = useRef<HTMLIFrameElement>(null);

	// Links clicked inside the opaque-origin preview are relayed here; only
	// http(s) from this frame is opened, in the system browser.
	useEffect(() => {
		if (!isHtml || tab.mode !== "preview") return;
		const onMessage = (e: MessageEvent) => {
			if (e.source !== iframeRef.current?.contentWindow) return;
			const url = relayedExternalUrl(e.data);
			if (url) void openUrl(url).catch((err: unknown) => toast.error(errMsg(err)));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [isHtml, tab.mode]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				void buffer.save();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [buffer]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-divider)] px-2.5 py-1 text-[11px]">
				<div className="flex shrink-0 items-center gap-1.5">
					<Segmented
						size="sm"
						aria-label={t("files.viewMode")}
						value={tab.mode}
						onChange={(mode) => setMode(tab.path, mode)}
						options={[
							{ value: "preview", label: t("files.tabPreview") },
							{ value: "edit", label: t("files.tabEdit") },
						]}
					/>
					{dirty && (
						<span className="shrink-0 whitespace-nowrap rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
							{t("files.unsaved")}
						</span>
					)}
				</div>
				<PathCopyButton path={tab.path} displayPath={shortPath(tab.path, home)} />
				<div className="flex shrink-0 items-center gap-0.5">
					<button
						type="button"
						title={t("files.saveShortcut")}
						aria-label={t("common.save")}
						disabled={!dirty || saving}
						onClick={() => void buffer.save()}
						className={
							dirty || tab.mode === "edit"
								? `flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 transition-colors disabled:opacity-40 ${
										dirty && !saving
											? "bg-[#0A84FF]/15 text-sky-300 hover:bg-[#0A84FF]/25"
											: "text-neutral-300 hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
									}`
								: "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-300 transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40"
						}
					>
						<Save size={13} className="shrink-0" />
						{(dirty || tab.mode === "edit") && <span>{t("common.save")}</span>}
					</button>
					<button
						type="button"
						title={t("files.reloadFromDisk")}
						aria-label={t("editor.reload")}
						onClick={() => void buffer.reload()}
						className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-300 transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
					>
						<RefreshCw size={13} />
					</button>
					<MaximizeToggleButton />
					<ExternalActions path={tab.path} isHtml={isHtml} />
				</div>
			</div>

			{error && (
				<div className="shrink-0 select-text whitespace-pre-wrap break-words border-b border-[var(--border-divider)] px-3 py-2 text-xs text-rose-400">
					{error}
				</div>
			)}
			{external && (
				<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-800/60 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-200">
					<span className="flex-1">{t("files.fileModifiedOnDisk")}</span>
					<button type="button" onClick={() => void buffer.reload()} className="rounded bg-amber-800/60 px-2 py-0.5 hover:bg-amber-700/60">
						{t("editor.reload")}
					</button>
					<button type="button" onClick={buffer.dismissExternal} className="px-1.5 text-amber-300/80">
						{t("files.keepMyChanges")}
					</button>
				</div>
			)}

			{saved === null && !error ? (
				<div className="py-6 text-center text-xs text-[var(--text-40)]">{t("files.loading")}</div>
			) : tab.mode === "edit" ? (
				<div className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-editor]:bg-neutral-950 [&_.cm-scroller]:font-mono [&_.cm-scroller]:text-xs">
					<Suspense fallback={<div className="py-6 text-center text-xs text-[var(--text-40)]">{t("files.loadingEditor")}</div>}>
						<FileEditor path={tab.path} value={draft} onChange={setDraft} />
					</Suspense>
				</div>
			) : (
                <div ref={previewRef} className={`${isHtml ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-auto px-4 py-3"} relative`}>
					{isMarkdown ? (
						<Markdown text={draft} cwd={tab.cwd ?? tab.path.replace(/\/[^/]*$/, "")} />
					) : isMermaid ? (
						<MermaidBlock source={draft} />
					) : isHtml ? (
						<iframe
							ref={iframeRef}
							title={basename(tab.path)}
							srcDoc={buildHtmlPreviewDoc(tab.path, draft)}
							sandbox={HTML_PREVIEW_SANDBOX}
							referrerPolicy="no-referrer"
							className="h-full w-full border-0 bg-white"
						/>
					) : (
						<pre className="select-text whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-[var(--text-60)]">
							{draft}
						</pre>
					)}
                    {sessionId && <AnnotationMarkers sessionId={sessionId} containerRef={previewRef} docFile={tab.path} />}
                    {sessionId && <SelectionToolbar sessionId={sessionId} containerRef={previewRef} docFile={tab.path} />}
				</div>
			)}
		</div>
	);
}

export function FilePreviewPanel() {
	const { t } = useT();
	const tabs = useFilePreview((s) => s.tabs);
	const activePath = useFilePreview((s) => s.activePath);
	const active = tabs.find((t) => t.path === activePath) ?? tabs[0] ?? null;

	if (!active) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-[var(--text-40)]">
				<FileText size={20} className="text-neutral-500" />
				<div>{t("files.noOpenFile")}</div>
				<div className="text-[11px]">{t("files.clickPathToPreview")}</div>
			</div>
		);
	}

	const kind = previewKind(active.path);
	return (
		<React.Fragment key={active.path}>
			{kind === "image" && !isHtmlPreviewPath(active.path) ? <ImageBody path={active.path} /> : <TextBody tab={active} />}
		</React.Fragment>
	);
}
