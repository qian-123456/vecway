import { nav, paths } from "../../core/nav";

type Panel = "chat" | "files" | "git" | "terminal" | "sidechat" | "services";

const PANELS: ReadonlyArray<{ current: Panel; label: string; to: (id: string) => string }> = [
	{ current: "chat", label: "对话", to: paths.chat },
	{ current: "files", label: "文件", to: paths.files },
	{ current: "git", label: "Git", to: paths.git },
	{ current: "terminal", label: "终端", to: paths.terminal },
	{ current: "sidechat", label: "辅助", to: paths.sidechat },
	{ current: "services", label: "服务", to: paths.services },
];

export function WorkspacePanelBar({ sessionId, current }: { sessionId: string; current: Panel }) {
	return (
		<div className="shrink-0">
			<nav aria-label="会话工作区" className="flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain px-4 pb-2">
				{PANELS.map((panel) => (
					<a
						key={panel.current}
						href={`#${panel.to(sessionId)}`}
						aria-current={current === panel.current ? "page" : undefined}
						onClick={(event) => {
							event.preventDefault();
							if (current !== panel.current) nav.push(panel.to(sessionId));
						}}
						className={`m-press inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center whitespace-nowrap rounded-m-pill px-3 text-m-sm font-medium active:bg-m-surface-2 ${current === panel.current ? "bg-m-accent-soft text-m-accent-soft-text" : "text-m-text-2"}`}
					>
						{panel.label}
					</a>
				))}
			</nav>
		</div>
	);
}
