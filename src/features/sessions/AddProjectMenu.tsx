import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, GitBranch, Loader2 } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { FloatingLayer } from "../../components/FloatingLayer";
import { Modal } from "../../components/Modal";
import { errMsg } from "../../lib/dialogs";
import { useHomeDir } from "../../lib/hooks";
import { gitCloneRepo } from "../../lib/ipc";
import { joinPath, shortPath } from "../../lib/paths";
import { useT } from "../../stores/language";

export const LAST_PROJECT_PARENT_DIR_KEY = "ompws:last-project-parent-dir";

export function readLastProjectParentDir(home: string | null): string {
	try {
		const saved = localStorage.getItem(LAST_PROJECT_PARENT_DIR_KEY);
		if (saved?.trim()) return saved;
	} catch {
		/* ignore storage errors */
	}
	return home ? joinPath(home, "Documents") : "";
}

function writeLastProjectParentDir(path: string): void {
	try {
		if (path.trim()) localStorage.setItem(LAST_PROJECT_PARENT_DIR_KEY, path.trim());
	} catch {
		/* ignore storage errors */
	}
}

/** Infer a clean single-segment folder name from a Git repository URL or path. */
export function deriveRepoNameFromUrl(url: string): string {
	let trimmed = url.trim().replace(/\/+$/, "");
	if (!trimmed) return "";
	if (/\.git$/i.test(trimmed)) {
		trimmed = trimmed.slice(0, -4).replace(/\/+$/, "");
	}
	const sepIdx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":"));
	const seg = sepIdx >= 0 ? trimmed.slice(sepIdx + 1) : trimmed;
	if (!seg || seg === "." || seg === ".." || /[/\\\0]/.test(seg)) return "";
	return seg;
}

export interface AddProjectPopoverProps {
	anchor: HTMLElement | null;
	ignoreRefs: RefObject<HTMLElement | null>[];
	onClose: () => void;
	onOpenFolder: () => void;
	onCloneRepo: () => void;
}

export function AddProjectPopover({
	anchor,
	ignoreRefs,
	onClose,
	onOpenFolder,
	onCloneRepo,
}: AddProjectPopoverProps) {
	const { t } = useT();

	if (!anchor) return null;

	const run = (fn: () => void) => () => {
		onClose();
		fn();
	};

	return (
		<FloatingLayer
			anchor={anchor}
			placement="bottom-start"
			offset={4}
			layer="menu"
			ignoreRefs={ignoreRefs}
			onDismiss={onClose}
			className="w-max select-none rounded-xl border border-[var(--border-divider)] !bg-[var(--bg-panel)] p-1 text-xs text-[var(--text)] shadow-apple-modal"
		>
			<div role="menu" aria-label={t("sidebar.addProjectDir")}>
				<button
					type="button"
					role="menuitem"
					onClick={run(onOpenFolder)}
					className="flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 pr-3 py-1.5 text-left text-xs text-[var(--text)] transition-colors hover:bg-[var(--bg-hover)]"
				>
					<FolderOpen size={14} className="shrink-0 text-[var(--text-muted)]" />
					<span>{t("sidebar.addProjectOpenFolder")}</span>
				</button>
				<button
					type="button"
					role="menuitem"
					onClick={run(onCloneRepo)}
					className="flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 pr-3 py-1.5 text-left text-xs text-[var(--text)] transition-colors hover:bg-[var(--bg-hover)]"
				>
					<GitBranch size={14} className="shrink-0 text-[var(--text-muted)]" />
					<span>{t("sidebar.addProjectCloneRepo")}</span>
				</button>
			</div>
		</FloatingLayer>
	);
}

export function CloneRepoModal({
	onClose,
	onProjectReady,
}: {
	onClose: () => void;
	onProjectReady: (clonedPath: string) => Promise<void> | void;
}) {
	const { t } = useT();
	const home = useHomeDir();
	const [repoUrl, setRepoUrl] = useState("");
	const [parentDir, setParentDir] = useState(() => readLastProjectParentDir(home));
	const parentEditedRef = useRef(false);
	const [folderName, setFolderName] = useState("");
	const [folderEdited, setFolderEdited] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!parentEditedRef.current && !parentDir && home) {
			setParentDir(readLastProjectParentDir(home));
		}
	}, [home, parentDir]);

	const handleUrlChange = (nextUrl: string) => {
		setRepoUrl(nextUrl);
		if (!folderEdited) {
			setFolderName(deriveRepoNameFromUrl(nextUrl));
		}
	};

	const handleBrowseParent = async () => {
		try {
			const selected = await open({
				directory: true,
				multiple: false,
				defaultPath: parentDir.trim() || undefined,
				title: t("sidebar.chooseParentDir"),
			});
			const chosen = typeof selected === "string" ? selected : selected?.[0];
			if (chosen) {
				parentEditedRef.current = true;
				setParentDir(chosen);
				setError(null);
			}
		} catch (err) {
			setError(errMsg(err));
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (busy) return;
		const cleanUrl = repoUrl.trim();
		const cleanParent = parentDir.trim();
		if (!cleanUrl) {
			setError(t("sidebar.repoUrlRequired"));
			return;
		}
		if (!cleanParent) {
			setError(t("sidebar.parentDirRequired"));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const clonedPath = await gitCloneRepo(
				cleanUrl,
				cleanParent,
				folderName.trim() || undefined,
			);
			writeLastProjectParentDir(cleanParent);
			await onProjectReady(clonedPath);
			onClose();
		} catch (err) {
			setError(errMsg(err));
		} finally {
			setBusy(false);
		}
	};

	const effectiveFolder = folderName.trim() || deriveRepoNameFromUrl(repoUrl);
	const previewPath =
		parentDir.trim() && effectiveFolder ? joinPath(parentDir.trim(), effectiveFolder) : "";

	return (
		<Modal
			title={t("sidebar.cloneRepoTitle")}
			icon={<GitBranch size={15} className="text-[var(--accent)]" />}
			size="md"
			closeOnBackdrop={!busy}
			closeOnEscape={!busy}
			onClose={onClose}
		>
			<form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 p-5 pt-4 text-xs text-[var(--text)]">
				<div className="space-y-1.5">
					<label className="block font-medium text-[var(--text-muted)]">
						{t("sidebar.repoUrlLabel")}
					</label>
					<input
						autoFocus
						type="text"
						value={repoUrl}
						onChange={(e) => handleUrlChange(e.target.value)}
						placeholder={t("sidebar.repoUrlPlaceholder")}
						disabled={busy}
						className="h-8 w-full rounded-lg hairline bg-[var(--well-bg)] px-2.5 font-mono text-xs text-[var(--text)] outline-none placeholder:text-[var(--text-dim)] focus:ring-1 focus:ring-[var(--accent)]"
					/>
				</div>

				<div className="space-y-1.5">
					<label className="block font-medium text-[var(--text-muted)]">
						{t("sidebar.parentDirLabel")}
					</label>
					<div className="flex items-center gap-2">
						<input
							type="text"
							value={parentDir}
							onChange={(e) => {
								parentEditedRef.current = true;
								setParentDir(e.target.value);
							}}
							placeholder={t("sidebar.parentDirPlaceholder")}
							disabled={busy}
							className="h-8 min-w-0 flex-1 rounded-lg hairline bg-[var(--well-bg)] px-2.5 font-mono text-xs text-[var(--text)] outline-none placeholder:text-[var(--text-dim)] focus:ring-1 focus:ring-[var(--accent)]"
						/>
						<button
							type="button"
							disabled={busy}
							onClick={() => void handleBrowseParent()}
							className="h-8 shrink-0 whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--well-bg)] px-3 font-medium text-[var(--text)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
						>
							{t("sidebar.chooseParentDir")}
						</button>
					</div>
				</div>

				<div className="space-y-1.5">
					<label className="block font-medium text-[var(--text-muted)]">
						{t("sidebar.cloneFolderNameLabel")}
					</label>
					<input
						type="text"
						value={folderName}
						onChange={(e) => {
							const v = e.target.value;
							setFolderName(v);
							setFolderEdited(v.trim().length > 0);
						}}
						placeholder={t("sidebar.cloneFolderNamePlaceholder")}
						disabled={busy}
						className="h-8 w-full rounded-lg hairline bg-[var(--well-bg)] px-2.5 font-mono text-xs text-[var(--text)] outline-none placeholder:text-[var(--text-dim)] focus:ring-1 focus:ring-[var(--accent)]"
					/>
					{previewPath && (
						<div className="break-all font-mono text-[10.5px] text-[var(--text-dim)]">
							{t("sidebar.cloneDestPreview", { path: shortPath(previewPath, home) })}
						</div>
					)}
				</div>

				{error && (
					<div className="whitespace-pre-wrap break-words rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11.5px] text-rose-500 dark:text-rose-300">
						{error}
					</div>
				)}

				<div className="flex items-center justify-end gap-2 pt-1">
					<button
						type="button"
						disabled={busy}
						onClick={onClose}
						className="h-8 whitespace-nowrap rounded-lg border border-[var(--border-divider)] bg-[var(--well-bg)] px-3.5 font-medium text-[var(--text)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
					>
						{t("common.cancel")}
					</button>
					<button
						type="submit"
						disabled={busy}
						className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg bg-[var(--accent)] px-3.5 font-medium text-[var(--accent-fg,#fff)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-60"
					>
						{busy && <Loader2 size={13} className="animate-spin" />}
						<span>{busy ? t("sidebar.cloningRepo") : t("sidebar.cloneAndAddAction")}</span>
					</button>
				</div>
			</form>
		</Modal>
	);
}
