import { FolderOpen, FolderPlus, History } from "lucide-react";
import { relTime, sessionName } from "../../../core/lib/format";
import { nav, paths } from "../../../core/nav";
import type { MobileSession } from "../../../core/types";

/**
 * Calm directory-first starter canvas shared by Home and empty Chat sessions.
 */
export function EmptyChatCanvas({
	dirName,
	dirSub,
	hasDirectory = true,
	directoryPath,
	onPickDirectory,
	recentSessions,
}: {
	dirName: string;
	dirSub: string;
	hasDirectory?: boolean;
	directoryPath?: string | null;
	onPickDirectory?: () => void;
	recentSessions?: readonly MobileSession[];
}) {
	return (
		<div className="m-kb-lift relative flex min-h-0 flex-1 flex-col justify-center px-6 pb-8">
			<div className="text-center">
				<h1 className="inline-flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[23px] font-semibold leading-snug tracking-[-0.02em] text-m-text">
					<span>在</span>
					<button
						type="button"
						disabled={!onPickDirectory}
						aria-label={directoryPath ? `当前目录：${directoryPath}，点击切换` : "选择当前目录"}
						onClick={onPickDirectory}
						className="inline-flex max-w-full items-center gap-1.5 border-b border-dashed border-m-border-strong pb-0.5 text-m-text transition-opacity duration-(--m-dur-press) ease-m active:opacity-70 disabled:border-transparent disabled:active:opacity-100"
					>
						{hasDirectory ? (
							<FolderOpen size={19} strokeWidth={1.85} className="shrink-0 text-m-accent" aria-hidden />
						) : (
							<FolderPlus size={19} strokeWidth={1.85} className="shrink-0 text-m-accent" aria-hidden />
						)}
						<span className="truncate">{dirName}</span>
					</button>
					<span>中开始</span>
				</h1>
				<p className="mt-2 truncate font-m-mono text-[12px] leading-relaxed text-m-text-3 tabular-nums">
					{dirSub}
				</p>
			</div>

			{recentSessions && recentSessions.length > 0 && (
				<div className="mx-auto mt-8 w-full max-w-[360px] border-t border-m-border pt-3">
					<div className="pb-1 text-[11.5px] font-medium text-m-text-3">继续最近对话</div>
					<div className="divide-y divide-m-border">
						{recentSessions.map((item) => (
							<button
								key={item.id}
								type="button"
								onClick={() => nav.push(paths.chat(item.id))}
								className="flex min-h-10 w-full items-center justify-between gap-3 py-2 text-left text-m-sm text-m-text transition-opacity duration-(--m-dur-press) ease-m active:opacity-65"
							>
								<span className="inline-flex min-w-0 items-center gap-2">
									<History size={14} strokeWidth={1.75} className="shrink-0 text-m-text-3" aria-hidden />
									<span className="truncate">{sessionName(item)}</span>
								</span>
								<span className="shrink-0 text-[11.5px] whitespace-nowrap text-m-text-3 tabular-nums">
									{relTime(item.updatedAt)}
								</span>
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
