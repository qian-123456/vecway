import clsx from "clsx";
import { ChevronDown, Folder } from "lucide-react";
import React, { useRef, useState } from "react";
import type { Workspace } from "../../lib/contracts";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FloatingLayer } from "../../components/FloatingLayer";
import { toast } from "../../lib/toast";
import { useT } from "../../stores/language";

interface WorkspaceCardProps {
	currentWorkspace: Workspace | null;
	workspaces: Workspace[];
	onSelectWorkspace: (ws: Workspace) => void;
}

export function WorkspaceCard({
	currentWorkspace,
	workspaces,
	onSelectWorkspace,
}: WorkspaceCardProps) {
	const { t } = useT();
	const [menuOpen, setMenuOpen] = useState(false);
	const cardRef = useRef<HTMLDivElement>(null);

	const name = currentWorkspace?.name || t("explorer.noWorkspaceSelected");
	const path = currentWorkspace?.path || "";

	const handleOpenInFinder = async (e: React.MouseEvent) => {
		e.stopPropagation();
		if (!path) return;
		try {
			await revealItemInDir(path);
		} catch (err) {
			toast.error(t("explorer.openInFinderFailed", { error: String(err) }));
		}
	};

	const canSwitch = workspaces.length > 1;
	const hasWorkspace = Boolean(currentWorkspace);

	return (
		<div className="relative min-w-0 flex-1">
			<div
				ref={cardRef}
				role={canSwitch ? "button" : undefined}
				tabIndex={canSwitch ? 0 : undefined}
				onClick={() => {
					if (canSwitch) {
						setMenuOpen((v) => !v);
					}
				}}
				onKeyDown={(e) => {
					if (canSwitch && (e.key === "Enter" || e.key === " ")) {
						e.preventDefault();
						setMenuOpen((v) => !v);
					}
				}}
				onContextMenu={(e) => {
					e.preventDefault();
					void handleOpenInFinder(e);
				}}
				className={clsx(
					"group flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 text-left transition-colors",
					canSwitch
						? "cursor-pointer hover:bg-[var(--bg-hover)] active:scale-[0.99]"
						: "cursor-default",
				)}
				title={
					path
						? t("explorer.workspaceCardTip", {
								name,
								path,
								switchHint: canSwitch ? t("explorer.switchHint") : "",
						  })
						: name
				}
			>
				<Folder
					size={13}
					className={clsx(
						"shrink-0",
						hasWorkspace ? "text-amber-500/90" : "text-[var(--text-dim)]",
					)}
				/>
				<span
					className={clsx(
						"min-w-0 truncate text-xs font-medium",
						hasWorkspace ? "text-[var(--text)]" : "text-[var(--text-muted)]",
					)}
				>
					{name}
				</span>
				{canSwitch && (
					<ChevronDown
						size={11}
						className={clsx(
							"shrink-0 text-[var(--text-muted)] transition-transform duration-150",
							menuOpen && "rotate-180 text-[var(--text)]",
						)}
					/>
				)}
			</div>

			{/* Workspace dropdown selector */}
			{workspaces.length > 1 && (
				<FloatingLayer
					anchor={menuOpen ? cardRef.current : null}
					placement="bottom-start"
					offset={4}
					layer="popover"
					ignoreRefs={[cardRef]}
					onDismiss={() => setMenuOpen(false)}
					className="w-max min-w-[180px] max-w-[300px] p-1"
				>
					<div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 whitespace-nowrap">
						{t("explorer.switchWorkspace")}
					</div>
					{workspaces.map((ws) => (
						<button
							key={ws.id}
							type="button"
							onClick={() => {
								onSelectWorkspace(ws);
								setMenuOpen(false);
							}}
							className={clsx(
								"flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-all active:scale-[0.98]",
								currentWorkspace?.id === ws.id
									? "bg-[#0A84FF]/15 text-[#0A84FF] font-medium"
									: "text-neutral-300 hover:bg-[var(--bg-hover)] hover:text-neutral-100",
							)}
						>
							<Folder size={12} className="shrink-0 text-amber-400/80" />
							<div className="min-w-0 flex-1 flex items-baseline gap-1.5 overflow-hidden">
								<span className="truncate font-medium">{ws.name}</span>
								<span className="truncate font-mono text-[10px] text-neutral-500 flex-1">
									{ws.path}
								</span>
							</div>
							{currentWorkspace?.id === ws.id && (
								<span className="h-1.5 w-1.5 rounded-full bg-[#0A84FF] shrink-0" />
							)}
						</button>
					))}
				</FloatingLayer>
			)}
		</div>
	);
}
