import clsx from "clsx";
import {
	Check,
	Crosshair,
	Eye,
	FolderOpen,
	FolderUp,
	FoldVertical,
	Loader2,
	MoreHorizontal,
	RefreshCw,
	Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirEntry } from "../../lib/contracts";
import { resolveActiveSessionTarget } from "../../lib/activeSessionTarget";
import { canPreviewFile } from "../../lib/fileLinks";
import { basename, isInside, shortPath, trimTrailingSlash } from "../../lib/paths";
import { usePendingSession } from "../sessions/pendingSession";
import { fsReadDir, listWorkspaceFiles } from "../../lib/ipc";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { EmptyState } from "../../components/EmptyState";
import { FloatingLayer } from "../../components/FloatingLayer";
import { SearchInput } from "../../components/SearchInput";
import { toast } from "../../lib/toast";
import { isComposing, useHomeDir } from "../../lib/hooks";
import { useExplorer } from "../../stores/explorer";
import { useFilePreview } from "../../stores/filePreview";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { FileIcon } from "./FileIcon";
import { FileTreeNode } from "./FileTreeNode";
import { WorkspaceCard } from "./WorkspaceCard";
import { collectForceVisiblePaths, filterVisibleEntries } from "./filterEntries";
import { keepIfEqual, useAutoRefresh } from "../git/useAutoRefresh";
import { claimEscape } from "../../lib/escapeClaim";
import { useT } from "../../stores/language";
import { focusDeferred, useSlashSearch } from "../shortcuts/searchShortcut";

export function FileExplorer() {
	const { t } = useT();
	const workspaces = useSessions((s) => s.workspaces);
	const sessions = useSessions((s) => s.sessions);
	const selectedSessionId = useUi((s) => s.selectedSessionId);
	const centerView = useUi((s) => s.centerView);
	const drafts = usePendingSession((s) => s.drafts);
	const selectedDraftId = usePendingSession((s) => s.selectedId);
	const activePreviewPath = useFilePreview((s) => s.activePath);

	const activeTarget = resolveActiveSessionTarget({
		selectedSessionId,
		selectedDraftId: !selectedSessionId && centerView === "session" ? selectedDraftId : null,
		drafts,
		sessions,
	});
	const manualWorkspaceId = useExplorer((s) => s.workspaceId);
	const setManualWorkspaceId = useExplorer((s) => s.setWorkspaceId);
	const customRootPath = useExplorer((s) => s.customRootPath);
	const pendingRevealPath = useExplorer((s) => s.pendingRevealPath);
	const revealNonce = useExplorer((s) => s.revealNonce);
	const setCustomRootPath = useExplorer((s) => s.setCustomRootPath);
	const clearCustomRoot = useExplorer((s) => s.clearCustomRoot);
	const showHidden = useExplorer((s) => s.showHidden);
	const setShowHidden = useExplorer((s) => s.setShowHidden);
	const toggleShowHidden = useExplorer((s) => s.toggleShowHidden);
	const home = useHomeDir();

	const currentWorkspace = useMemo(() => {
		if (workspaces.length === 0) return null;
		if (manualWorkspaceId) {
			const found = workspaces.find((w) => w.id === manualWorkspaceId);
			if (found) return found;
		}
		const found = workspaces.find((w) => w.id === activeTarget.workspaceId)
			?? workspaces.filter((w) => w.kind !== "global" && activeTarget.cwd &&
				(activeTarget.cwd === w.path || activeTarget.cwd.startsWith(`${w.path}/`)))
				.sort((a, b) => b.path.length - a.path.length)[0];
		if (!found || !activeTarget.cwd) return null;
		return { ...found, path: activeTarget.cwd };
	}, [workspaces, manualWorkspaceId, activeTarget.workspaceId, activeTarget.cwd]);

	const effectiveRootPath = customRootPath ?? currentWorkspace?.path ?? null;

	// Tree state
	const [rootEntries, setRootEntries] = useState<DirEntry[]>([]);
	const [childrenMap, setChildrenMap] = useState<Record<string, DirEntry[]>>({});
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
	const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
	const [selectedPath, setSelectedPath] = useState<string | null>(activePreviewPath);
	const [isRootLoading, setIsRootLoading] = useState(false);
	const rootPathRef = useRef(effectiveRootPath);
	rootPathRef.current = effectiveRootPath;
	const [pendingScrollPath, setPendingScrollPath] = useState<string | null>(null);
	const expandedPathsRef = useRef(expandedPaths);
	expandedPathsRef.current = expandedPaths;
	const [moreMenuOpen, setMoreMenuOpen] = useState(false);
	const moreBtnRef = useRef<HTMLButtonElement>(null);

	const activeSession = selectedSessionId ? sessions[selectedSessionId] : undefined;
	const sessionActivityKey = activeSession
		? `${activeSession.id}:${activeSession.status}:${activeSession.updatedAt}`
		: null;
	const prevSessionActivityRef = useRef(sessionActivityKey);

	// Search state
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<string[]>([]);
	const [isSearchingFiles, setIsSearchingFiles] = useState(false);
	const [searchLimit, setSearchLimit] = useState(50);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	useSlashSearch(
		() => {
			setSearchOpen(true);
			focusDeferred(searchInputRef);
		},
		{ tier: "panel", scopeRef: panelRef },
	);

	// Sync selectedPath when active right-panel preview tab changes externally
	useEffect(() => {
		if (activePreviewPath) {
			setSelectedPath(activePreviewPath);
		}
	}, [activePreviewPath]);

	// Load directory entries for path
	const loadDir = useCallback(async (path: string) => {
		setLoadingPaths((prev) => new Set(prev).add(path));
		try {
			const entries = await fsReadDir(path);
			setChildrenMap((prev) => ({ ...prev, [path]: entries }));
			return entries;
		} catch (err) {
			toast.error(t("explorer.readDirFailed", { error: String(err) }));
			return [];
		} finally {
			setLoadingPaths((prev) => {
				const next = new Set(prev);
				next.delete(path);
				return next;
			});
		}
	}, []);

	// Refresh root directory and reload expanded directories under the effective root.
	// Silent mode avoids spinners, error toasts, and unnecessary re-renders for background sync.
	const refreshTree = useCallback(
		async (opts?: { silent?: boolean }) => {
			const root = rootPathRef.current;
			if (!root) {
				setRootEntries((prev) => (prev.length === 0 ? prev : []));
				return;
			}
			const silent = opts?.silent ?? false;
			if (!silent) setIsRootLoading(true);
			try {
				const entries = await fsReadDir(root);
				if (rootPathRef.current !== root) return;
				setRootEntries((prev) => keepIfEqual(prev, entries));

				const expanded = Array.from(expandedPathsRef.current).filter((p) => isInside(p, root));
				if (expanded.length > 0) {
					const results = await Promise.allSettled(
						expanded.map(async (dir) => [dir, await fsReadDir(dir)] as const),
					);
					if (rootPathRef.current !== root) return;
					const updated: Record<string, DirEntry[]> = {};
					const deletedDirs: string[] = [];
					results.forEach((res, i) => {
						if (res.status === "fulfilled") {
							updated[res.value[0]] = res.value[1];
						} else if (silent) {
							deletedDirs.push(expanded[i]);
						}
					});
					if (Object.keys(updated).length > 0 || deletedDirs.length > 0) {
						setChildrenMap((prev) => {
							let changed = false;
							const next = { ...prev };
							for (const [dir, list] of Object.entries(updated)) {
								const kept = keepIfEqual(prev[dir], list);
								if (kept !== prev[dir]) {
									next[dir] = kept;
									changed = true;
								}
							}
							for (const dir of deletedDirs) {
								if (dir in next) {
									delete next[dir];
									changed = true;
								}
							}
							return changed ? next : prev;
						});
						if (deletedDirs.length > 0) {
							setExpandedPaths((prev) => {
								const next = new Set(prev);
								for (const dir of deletedDirs) next.delete(dir);
								return next.size === prev.size ? prev : next;
							});
						}
					}
				}
			} catch (err) {
				if (rootPathRef.current !== root) return;
				if (!silent) {
					toast.error(t("explorer.loadWorkspaceFilesFailed", { error: String(err) }));
					setRootEntries([]);
				}
			} finally {
				if (!silent && rootPathRef.current === root) setIsRootLoading(false);
			}
		},
		[t],
	);

	// Auto-refresh on window focus, tab visibility restore, and calm interval while visible
	useAutoRefresh(() => void refreshTree({ silent: true }), 10_000);

	// Auto-refresh shortly after the active session's status/updatedAt changes (e.g. AI edits files)
	useEffect(() => {
		if (prevSessionActivityRef.current === sessionActivityKey) return;
		prevSessionActivityRef.current = sessionActivityKey;
		if (!effectiveRootPath || !sessionActivityKey) return;
		const timer = window.setTimeout(() => {
			void refreshTree({ silent: true });
		}, 250);
		return () => window.clearTimeout(timer);
	}, [sessionActivityKey, effectiveRootPath, refreshTree]);

	// Reset tree expansion and cache on root change, then load new root
	useEffect(() => {
		let cancelled = false;
		setExpandedPaths(new Set());
		setChildrenMap({});
		if (!effectiveRootPath) {
			setRootEntries([]);
			return;
		}
		setIsRootLoading(true);
		fsReadDir(effectiveRootPath)
			.then((entries) => {
				if (cancelled) return;
				setRootEntries(entries);
			})
			.catch((err) => {
				if (cancelled) return;
				toast.error(t("explorer.loadWorkspaceFilesFailed", { error: String(err) }));
				setRootEntries([]);
			})
			.finally(() => {
				if (cancelled) return;
				setIsRootLoading(false);
			});
		return () => { cancelled = true; };
	}, [effectiveRootPath]);

	// Reveal/expand a directory requested from chat links or external callers
	useEffect(() => {
		if (!pendingRevealPath) return;
		const target = pendingRevealPath;
		const nonce = revealNonce;
		const wsRoot = currentWorkspace?.path
			? (trimTrailingSlash(currentWorkspace.path) || "/")
			: null;
		const insideWorkspace = !!wsRoot && isInside(target, wsRoot);

		setSearchQuery("");

		if (!insideWorkspace) {
			setCustomRootPath(target);
			setSelectedPath(target);
			useExplorer.setState((s) => (s.revealNonce === nonce ? { pendingRevealPath: null } : s));
			return;
		}

		// If a temporary custom root is active, clear it first and let the next render
		// reset the tree to the workspace root before expanding the target path.
		if (customRootPath !== null) {
			clearCustomRoot();
			return;
		}

		let cancelled = false;
		const rel =
			target === wsRoot
				? ""
				: wsRoot === "/"
					? target.slice(1)
					: target.slice(wsRoot.length + 1);
		const segments = rel ? rel.split("/").filter(Boolean) : [];
		const dirsToExpand: string[] = [];
		let acc = wsRoot;
		for (const seg of segments) {
			acc = acc === "/" ? `/${seg}` : `${acc}/${seg}`;
			dirsToExpand.push(acc);
		}

		setSelectedPath(target);
		if (dirsToExpand.length > 0) {
			setExpandedPaths((prev) => {
				const next = new Set(prev);
				for (const dir of dirsToExpand) next.add(dir);
				return next;
			});
			setPendingScrollPath(target);
		}

		void (async () => {
			const loaded: Record<string, DirEntry[]> = {};
			await Promise.all(
				dirsToExpand.map(async (dir) => {
					try {
						loaded[dir] = await fsReadDir(dir);
					} catch (err) {
						if (!cancelled) {
							toast.error(t("explorer.readDirFailed", { error: String(err) }));
						}
					}
				}),
			);
			if (cancelled) return;
			if (Object.keys(loaded).length > 0) {
				setChildrenMap((prev) => ({ ...prev, ...loaded }));
			}
			useExplorer.setState((s) => (s.revealNonce === nonce ? { pendingRevealPath: null } : s));
		})();

		return () => {
			cancelled = true;
		};
	}, [
		pendingRevealPath,
		revealNonce,
		customRootPath,
		currentWorkspace?.path,
		setCustomRootPath,
		clearCustomRoot,
	]);

	// Scroll the revealed directory node into view once it renders in the tree
	useEffect(() => {
		if (!pendingScrollPath) return;
		const container = panelRef.current;
		if (!container) return;
		for (const el of container.querySelectorAll<HTMLElement>("[data-tree-path]")) {
			if (el.dataset.treePath === pendingScrollPath) {
				el.scrollIntoView?.({ block: "nearest" });
				setPendingScrollPath(null);
				return;
			}
		}
	}, [pendingScrollPath, rootEntries, childrenMap, expandedPaths]);

	// Toggle folder expand/collapse
	const handleToggleExpand = useCallback(
		async (path: string) => {
			if (expandedPaths.has(path)) {
				setExpandedPaths((prev) => {
					const next = new Set(prev);
					next.delete(path);
					return next;
				});
			} else {
				setExpandedPaths((prev) => new Set(prev).add(path));
				if (!childrenMap[path]) {
					await loadDir(path);
				}
			}
		},
		[expandedPaths, childrenMap, loadDir],
	);

	// Collapse all directories
	const handleCollapseAll = () => {
		setExpandedPaths(new Set());
	};

	// Previewable files always open in right-panel preview tabs; refuse binary/external files.
	const handleOpenFile = (path: string) => {
		setSelectedPath(path);
		if (canPreviewFile(path)) {
			useFilePreview.getState().openFile(path, { cwd: effectiveRootPath ?? null });
		} else {
			toast.error(t("shell.blockedPreviewNonTextOrImage", { name: basename(path) }));
		}
	};

	// Reveal current effective root in Finder
	const handleRevealInFinder = async () => {
		if (!effectiveRootPath) return;
		try {
			await revealItemInDir(effectiveRootPath);
		} catch (err) {
			toast.error(t("explorer.openInFinderFailed", { error: String(err) }));
		}
	};

	const canRevealActiveFile = Boolean(
		activePreviewPath && effectiveRootPath && isInside(activePreviewPath, effectiveRootPath),
	);

	const handleRevealActiveFile = useCallback(async () => {
		if (!activePreviewPath || !effectiveRootPath || !isInside(activePreviewPath, effectiveRootPath)) {
			return;
		}
		setSearchQuery("");
		setSearchOpen(false);
		const root = trimTrailingSlash(effectiveRootPath) || "/";
		const rel =
			activePreviewPath === root
				? ""
				: root === "/"
					? activePreviewPath.slice(1)
					: activePreviewPath.slice(root.length + 1);
		const segments = rel ? rel.split("/").filter(Boolean) : [];
		const dirsToExpand: string[] = [];
		let acc = root;
		for (let i = 0; i < segments.length - 1; i++) {
			acc = acc === "/" ? `/${segments[i]}` : `${acc}/${segments[i]}`;
			dirsToExpand.push(acc);
		}
		setSelectedPath(activePreviewPath);
		if (dirsToExpand.length > 0) {
			setExpandedPaths((prev) => {
				const next = new Set(prev);
				for (const dir of dirsToExpand) next.add(dir);
				return next;
			});
			const loaded: Record<string, DirEntry[]> = {};
			await Promise.all(
				dirsToExpand.map(async (dir) => {
					try {
						loaded[dir] = await fsReadDir(dir);
					} catch (err) {
						toast.error(t("explorer.readDirFailed", { error: String(err) }));
					}
				}),
			);
			if (Object.keys(loaded).length > 0) {
				setChildrenMap((prev) => ({ ...prev, ...loaded }));
			}
		}
		setPendingScrollPath(activePreviewPath);
	}, [activePreviewPath, effectiveRootPath, t]);

	const forceVisiblePaths = useMemo(
		() => collectForceVisiblePaths(effectiveRootPath, selectedPath, expandedPaths),
		[effectiveRootPath, selectedPath, expandedPaths],
	);
	const visibleRootEntries = useMemo(
		() => filterVisibleEntries(rootEntries, showHidden, forceVisiblePaths),
		[rootEntries, showHidden, forceVisiblePaths],
	);

	// Perform workspace file search when query changes
	useEffect(() => {
		let cancelled = false;
		const q = searchQuery.trim();
		if (!q || !effectiveRootPath) {
			setSearchResults([]);
			return;
		}
		setSearchLimit(50);
		const timer = setTimeout(async () => {
			setIsSearchingFiles(true);
			try {
				const allFiles = await listWorkspaceFiles(effectiveRootPath);
				if (cancelled) return;
				const lowerQ = q.toLowerCase();
				const matched = allFiles.filter((rel) =>
					rel.toLowerCase().includes(lowerQ),
				);
				setSearchResults(matched);
			} catch {
				if (!cancelled) setSearchResults([]);
			} finally {
				if (!cancelled) setIsSearchingFiles(false);
			}
		}, 150);
		return () => { cancelled = true; clearTimeout(timer); };
	}, [searchQuery, effectiveRootPath]);

	return (
		<div ref={panelRef} tabIndex={-1} data-slash-panel="" className="flex h-full flex-col bg-transparent text-neutral-300 text-xs select-none outline-none">
			{/* Compact single-row toolbar: workspace/dir selector + Search + More menu */}
			<div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--border-divider)] px-2">
				{searchOpen ? (
					<SearchInput
						ref={searchInputRef}
						value={searchQuery}
						onChange={setSearchQuery}
						shortcutHint="/"
						placeholder={t("explorer.searchFilterPlaceholder")}
						iconSize={12}
						showClearWhenEmpty
						onClear={() => {
							if (!searchQuery) {
								setSearchOpen(false);
								panelRef.current?.focus();
							}
						}}
						className="min-w-0 flex-1"
						inputClassName="h-6 w-full rounded-md hairline bg-[var(--well-bg)] py-0.5 pl-6 pr-6 text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] focus:ring-1 focus:ring-[#0A84FF]/50 focus:outline-none"
						onKeyDown={(e) => {
							if (isComposing(e)) return;
							if (e.key === "Escape" && !searchQuery) {
								claimEscape(e);
								setSearchOpen(false);
								panelRef.current?.focus();
							}
						}}
					/>
				) : (
					<div className="flex min-w-0 flex-1 items-center gap-1">
						{customRootPath ? (
							<>
								<div
									className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5"
									title={customRootPath}
									onContextMenu={(e) => {
										e.preventDefault();
										void handleRevealInFinder();
									}}
								>
									<FolderOpen size={13} className="shrink-0 text-[var(--accent)]" />
									<span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-[var(--text)]">
										{shortPath(customRootPath, home)}
									</span>
								</div>
								<button
									type="button"
									onClick={clearCustomRoot}
									className="shrink-0 whitespace-nowrap rounded-md border border-[var(--line)] bg-[var(--bg-panel)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--bg-hover)] active:scale-95"
								>
									{t("explorer.backToWorkspace")}
								</button>
							</>
						) : (
							<WorkspaceCard
								currentWorkspace={currentWorkspace}
								workspaces={workspaces}
								onSelectWorkspace={(ws) => setManualWorkspaceId(ws.id)}
							/>
						)}
					</div>
				)}

				<div className="flex shrink-0 items-center gap-0.5">
					{!searchOpen && (
						<button
							type="button"
							onClick={() => {
								setSearchOpen(true);
								focusDeferred(searchInputRef);
							}}
							className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:scale-95"
							title={t("explorer.searchFilesTip")}
							aria-label={t("explorer.searchFilesTip")}
						>
							<Search size={13} />
						</button>
					)}
					<button
						ref={moreBtnRef}
						type="button"
						onClick={() => setMoreMenuOpen((v) => !v)}
						className={clsx(
							"flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors active:scale-95",
							moreMenuOpen
								? "bg-[var(--bg-hover)] text-[var(--text)]"
								: "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
						)}
						title={t("explorer.explorerActions")}
						aria-label={t("explorer.explorerActions")}
						aria-expanded={moreMenuOpen}
						aria-haspopup="menu"
					>
						<MoreHorizontal size={14} />
					</button>
				</div>
			</div>

			<FloatingLayer
				anchor={moreMenuOpen ? moreBtnRef.current : null}
				placement="bottom-end"
				offset={4}
				layer="menu"
				ignoreRefs={[moreBtnRef]}
				onDismiss={() => setMoreMenuOpen(false)}
				className="min-w-[180px] p-1 text-xs text-[var(--text)]"
			>
				<button
					type="button"
					role="menuitemcheckbox"
					aria-checked={showHidden}
					onClick={() => {
						toggleShowHidden();
						setMoreMenuOpen(false);
					}}
					className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] active:scale-[0.98]"
				>
					<Eye size={13} className="shrink-0 text-[var(--text-muted)]" />
					<span className="flex-1 whitespace-nowrap">{t("explorer.showHiddenFiles")}</span>
					<Check
						size={12}
						className={clsx("shrink-0 text-[var(--accent)]", !showHidden && "opacity-0")}
					/>
				</button>
				<button
					type="button"
					role="menuitem"
					disabled={!canRevealActiveFile}
					onClick={() => {
						setMoreMenuOpen(false);
						void handleRevealActiveFile();
					}}
					className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
				>
					<Crosshair size={13} className="shrink-0 text-[var(--text-muted)]" />
					<span className="whitespace-nowrap">{t("explorer.revealActiveFile")}</span>
				</button>
				<div className="my-1 border-t border-[var(--border-divider)]" />
				<button
					type="button"
					role="menuitem"
					disabled={expandedPaths.size === 0}
					onClick={() => {
						setMoreMenuOpen(false);
						handleCollapseAll();
					}}
					className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
				>
					<FoldVertical size={13} className="shrink-0 text-[var(--text-muted)]" />
					<span className="whitespace-nowrap">{t("explorer.collapseAllTip")}</span>
				</button>
				<button
					type="button"
					role="menuitem"
					disabled={!effectiveRootPath}
					onClick={() => {
						setMoreMenuOpen(false);
						void handleRevealInFinder();
					}}
					className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
				>
					<FolderUp size={13} className="shrink-0 text-[var(--text-muted)]" />
					<span className="whitespace-nowrap">{t("explorer.revealInFinder")}</span>
				</button>
				<button
					type="button"
					role="menuitem"
					disabled={!effectiveRootPath}
					onClick={() => {
						setMoreMenuOpen(false);
						void refreshTree({ silent: false });
					}}
					className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
				>
					<RefreshCw
						size={13}
						className={clsx("shrink-0 text-[var(--text-muted)]", isRootLoading && "animate-spin")}
					/>
					<span className="whitespace-nowrap">{t("explorer.refreshTreeTip")}</span>
				</button>
			</FloatingLayer>

			{/* Tree or Search Results Container */}
			<div className="flex-1 overflow-y-auto px-0.5 py-0.5 focus:outline-none">
				{/* Search Results Mode */}
				{searchQuery.trim().length > 0 ? (
					<div className="space-y-0.5">
						<div className="px-2 py-0.5 text-[10.5px] text-neutral-500 flex items-center justify-between">
							<span>{t("explorer.searchResults", { count: searchResults.length })}</span>
							{isSearchingFiles && <Loader2 size={11} className="animate-spin" />}
						</div>
						{searchResults.length === 0 && !isSearchingFiles ? (
							<div className="py-4 text-center text-xs text-neutral-500">
								{t("explorer.noMatchingFiles")}
							</div>
						) : (
							<>
								{searchResults.slice(0, searchLimit).map((rel) => {
									const full = effectiveRootPath
										? `${effectiveRootPath}/${rel}`
										: rel;
									const fileName = rel.split("/").pop() || rel;
									const isSelected = selectedPath === full;
									return (
										<div
											key={rel}
											role="button"
											tabIndex={0}
											onClick={() => handleOpenFile(full)}
											className={clsx(
												"flex h-5 items-center gap-1.5 rounded px-2 text-xs transition-all active:scale-[0.98] cursor-pointer",
												isSelected
													? "bg-[#0A84FF]/15 text-[#0A84FF] font-medium"
													: "text-neutral-300 hover:bg-[var(--bg-hover)] hover:text-neutral-100",
											)}
											title={full}
										>
											<FileIcon name={fileName} size={11} />
											<div className="min-w-0 flex-1 flex items-baseline gap-1.5 overflow-hidden">
												<span className="truncate font-mono text-[10.5px] leading-tight text-neutral-200">
													{fileName}
												</span>
												<span className="truncate font-mono text-[9.5px] text-neutral-500 leading-tight flex-1">
													{rel}
												</span>
											</div>
										</div>
									);
								})}
								{searchResults.length > searchLimit && (
									<button
										type="button"
										onClick={() => setSearchLimit((l) => l + 50)}
										className="w-full py-1 text-center text-[10.5px] text-neutral-400 hover:text-neutral-200 hover:bg-[var(--bg-hover)] rounded transition-colors"
									>
										{t("explorer.showMoreRemaining", { count: searchResults.length - searchLimit })}
									</button>
								)}
							</>
						)}
					</div>
				) : (
					/* Regular File Tree Mode */
					<div>
						{isRootLoading && rootEntries.length === 0 ? (
							<div className="flex items-center justify-center gap-1.5 py-6 text-neutral-500 text-xs">
								<Loader2 size={13} className="animate-spin" />
								<span>{t("explorer.loadingDirectory")}</span>
							</div>
						) : rootEntries.length === 0 ? (
							<EmptyState title={customRootPath ? t("explorer.emptyDirectory") : t("explorer.noFilesInWorkspace")} />
						) : visibleRootEntries.length === 0 ? (
							<div className="flex flex-col items-center justify-center gap-2 py-6 text-center text-xs text-[var(--text-muted)]">
								<span>{t("explorer.allItemsHidden")}</span>
								<button
									type="button"
									onClick={() => setShowHidden(true)}
									className="whitespace-nowrap rounded-md border border-[var(--line)] bg-[var(--bg-panel)] px-2 py-0.5 text-[11px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--bg-hover)]"
								>
									{t("explorer.showHiddenAction")}
								</button>
							</div>
						) : (
							visibleRootEntries.map((entry) => (
								<FileTreeNode
									key={entry.path}
									entry={entry}
									depth={0}
									rootPath={effectiveRootPath || ""}
									expandedPaths={expandedPaths}
									selectedPath={selectedPath}
									onToggleExpand={handleToggleExpand}
									onSelectPath={(path) => {
										setSelectedPath(path);
									}}
									onOpenFile={handleOpenFile}
									childrenMap={childrenMap}
									loadingPaths={loadingPaths}
									onRefreshDir={loadDir}
									showHidden={showHidden}
									forceVisiblePaths={forceVisiblePaths}
								/>
							))
						)}
					</div>
				)}
			</div>
		</div>
	);
}
