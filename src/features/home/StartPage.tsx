import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowUp, ChevronDown, Folder, FolderPlus, Loader2, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { HomeRecentSessions, StartGlow, StartHero } from "../../components/StartHero";
import { LoadFailed } from "../../components/LoadFailed";
import { errMsg } from "../../lib/dialogs";
import { deriveLoadState } from "../../lib/loadState";
import { addWorkspace } from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { useT } from "../../stores/language";
import { useComposer } from "../../stores/composer";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { usePendingSession } from "../sessions/pendingSession";
import { useSidebarStore } from "../sessions/sidebarStore";
import { resolveNewSessionTargetWorkspace } from "../sessions/modes";
import { startNewSession, startSessionInDir } from "../sessions/newSession";

/** Auto-launch tries per failure streak before the launcher shows a retry button. */
const MAX_AUTO_ATTEMPTS = 2;

const useLauncher = create<{ attempts: number }>(() => ({ attempts: 0 }));

async function launch(manual: boolean): Promise<void> {
	useLauncher.setState((s) => ({ attempts: manual ? 1 : s.attempts + 1 }));
	await startNewSession();
	const started =
		useUi.getState().selectedSessionId !== null ||
		usePendingSession.getState().selectedId !== null;
	if (started) useLauncher.setState({ attempts: 0 });
	else if (manual) useLauncher.setState({ attempts: MAX_AUTO_ATTEMPTS });
}

function LaunchComposer({
	onLaunch,
	failed,
	onRetry,
}: {
	onLaunch: () => Promise<void>;
	failed: boolean;
	onRetry: () => void;
}) {
	const { t } = useT();
	const [text, setText] = useState("");
	const activeMode = useSidebarStore((s) => s.activeMode);
	const creating = useSidebarStore((s) => s.creatingKey !== null);
	const workspaces = useSessions((s) => s.workspaces);
	const sessions = useSessions((s) => s.sessions);
	const target = resolveNewSessionTargetWorkspace(activeMode, null, sessions, workspaces);
	const ref = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		ref.current?.focus();
	}, []);

	const handleChange = (value: string) => {
		setText(value);
		if (!value) return;
		void onLaunch();
		const sink = useUi.getState().selectedSessionId ?? usePendingSession.getState().selectedId;
		if (sink) useComposer.getState().setDraft(sink, value);
	};

	return (
		<div className="start-rise w-full px-3 pb-3 pt-1 select-text">
			<div className="relative z-0 flex items-center justify-between px-[22px]">
				<div className="inline-flex max-w-full items-center gap-1.5 rounded-t-[14px] border border-b-0 border-[var(--composer-border,var(--border))] bg-[var(--bg-ear)] px-3 pt-1.5 pb-2.5 -mb-2 text-[12px] text-[var(--text-60,var(--text-muted))]">
					<Folder size={13} className="shrink-0 text-[var(--text-muted)]" />
					<span title={target?.path} className="font-medium text-[var(--text)]">
						{target ? target.name : t("home.noProjectSelected")}
					</span>
					{failed ? (
						<button
							type="button"
							onClick={onRetry}
							className="ml-1.5 whitespace-nowrap rounded-md border border-red-400/50 bg-red-500/10 px-2 py-0.5 text-[11.5px] text-red-500 transition-colors hover:bg-red-500/20"
						>
							{t("home.sessionStartFailedRetry")}
						</button>
					) : (
						<span className="ml-1.5 flex items-center gap-1.5 whitespace-nowrap text-[var(--text-40,var(--text-dim))]">
							<Loader2 size={11.5} className="animate-spin" />
							{creating ? t("home.creatingSession") : t("home.preparingSession")}
						</span>
					)}
				</div>
			</div>
			<div className="composer-optical-card relative z-10 w-full rounded-[22px] border border-[var(--composer-border,var(--border))]">
				<textarea
					ref={ref}
					value={text}
					rows={1}
					onChange={(e) => handleChange(e.target.value)}
					placeholder={t("home.inputPlaceholder")}
					aria-label={t("home.inputAriaLabel")}
					className="field-sizing-content min-h-[1.35em] w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-[14px] leading-[1.35] text-[var(--text)] outline-none placeholder:text-[var(--text-40,var(--text-dim))]"
				/>
				<div className="flex items-center justify-between px-2.5 pb-2.5 text-[12px] text-[var(--text-40,var(--text-dim))]">
					<div className="flex items-center gap-0.5">
						<span className="flex h-7 w-7 items-center justify-center">
							<Plus size={15} />
						</span>
						<span className="flex items-center gap-1.5 px-2 py-1">
							<Loader2 size={12} className="animate-spin" />
							{t("home.loadingModel")}
						</span>
					</div>
					<span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--bg-active-fill)] text-[var(--text-30,var(--text-dim))]">
						<ArrowUp size={14} />
					</span>
				</div>
			</div>
		</div>
	);
}

export function StartPage() {
	const { t } = useT();
	const activeMode = useSidebarStore((s) => s.activeMode);
	const ready = useSessions((s) => s.workspaces.some((w) => w.mode === activeMode));
	const loadState = deriveLoadState(
		useSessions((s) => s.hasLoaded),
		useSessions((s) => s.loadError),
	);
	const loadError = useSessions((s) => s.loadError);
	const creating = useSidebarStore((s) => s.creatingKey !== null);
	const attempts = useLauncher((s) => s.attempts);
	const failed = ready && !creating && attempts >= MAX_AUTO_ATTEMPTS;

	useEffect(() => {
		if (!ready || loadState !== "ready" || creating || attempts >= MAX_AUTO_ATTEMPTS) return;
		void launch(false);
	}, [ready, loadState, creating, activeMode, attempts]);

	const pickDirectory = async () => {
		try {
			const selected = await openDialog({
				directory: true,
				multiple: false,
				title: t("home.selectProjectDir"),
			});
			const path = typeof selected === "string" ? selected : selected?.[0];
			if (!path) return;
			const ws = await addWorkspace(path, activeMode);
			await useSessions.getState().refreshWorkspaces();
			await startSessionInDir(ws, false);
		} catch (e) {
			toast.error(t("home.addWorkspaceFailed", { error: errMsg(e) }));
		}
	};

	return (
		<div className="relative flex h-full w-full flex-col overflow-y-auto select-none">
			<div className="min-h-[24px] flex-[0.95]" aria-hidden="true" />
			<StartGlow />
			<StartHero onPickDirectory={() => void pickDirectory()} />
			<div className="mx-auto w-full max-w-[780px] px-6">
				{loadState === "loading" ? (
					<div className="px-3">
						<div
							role="status"
							className="composer-optical-card start-rise flex w-full animate-pulse items-center gap-2 rounded-[22px] border border-[var(--composer-border,var(--border))] px-4 py-6 text-[14px] text-[var(--text-40,var(--text-dim))]"
						>
							<Loader2 size={14} className="animate-spin" />
							{t("home.loading")}
						</div>
					</div>
				) : loadState === "error" ? (
					<div className="px-3">
						<div className="composer-optical-card start-rise w-full rounded-[22px] border border-[var(--composer-border,var(--border))]">
							<LoadFailed
								what={t("home.projectList")}
								error={loadError}
								onRetry={() => void useSessions.getState().load().catch(() => {})}
							/>
						</div>
					</div>
				) : ready ? (
					<>
						<LaunchComposer
							onLaunch={() => startNewSession()}
							failed={failed}
							onRetry={() => void launch(true)}
						/>
						<HomeRecentSessions />
					</>
				) : (
					<div className="start-rise w-full px-3 pb-3 pt-1">
						<div className="relative z-0 flex items-center justify-between px-[22px]">
							<button
								type="button"
								onClick={() => void pickDirectory()}
								className="inline-flex items-center gap-1.5 rounded-t-[14px] border border-b-0 border-[var(--composer-border,var(--border))] bg-[var(--bg-ear)] px-3 pt-1.5 pb-2.5 -mb-2 text-[12px] font-medium text-[var(--text)] transition-colors hover:text-[var(--accent)] cursor-pointer"
							>
								<FolderPlus size={13} className="shrink-0 text-[var(--text-muted)]" />
								<span>{t("home.selectProjectDir")}</span>
								<ChevronDown size={11} className="shrink-0 text-[var(--text-40,var(--text-dim))]" />
							</button>
						</div>
						<button
							type="button"
							onClick={() => void pickDirectory()}
							className="composer-optical-card relative z-10 w-full rounded-[22px] border border-[var(--composer-border,var(--border))] text-left transition-colors hover:border-[var(--text-30,var(--border))] cursor-pointer"
							aria-label={t("home.selectProjectDirToStart")}
						>
							<div className="px-4 pb-3 pt-3.5 text-[14px] text-[var(--text-40,var(--text-dim))]">
								{t("home.selectProjectDirFirst")}
							</div>
							<div className="flex items-center justify-between px-3.5 pb-3">
								<Plus size={16} className="text-[var(--text-40,var(--text-dim))]" />
								<span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--bg-active-fill)] text-[var(--text-40,var(--text-dim))]">
									<ArrowUp size={15} />
								</span>
							</div>
						</button>
					</div>
				)}
			</div>
			<div className="min-h-[24px] flex-[1.05]" aria-hidden="true" />
		</div>
	);
}
