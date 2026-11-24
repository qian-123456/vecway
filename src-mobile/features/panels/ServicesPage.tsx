import {
	ChevronDown,
	ChevronRight,
	Copy,
	ExternalLink,
	FolderOpen,
	MoreHorizontal,
	Server,
	Square,
} from "lucide-react";
import { useMemo, useState } from "react";
import { api, errorMessage } from "../../core/api";
import { copyText, sessionName } from "../../core/lib/format";
import { nav, type PageProps } from "../../core/nav";
import { useSession, useSessions } from "../../core/stores/sessions";
import {
	AnchoredPopover,
	EmptyState,
	IconButton,
	ListGroup,
	MenuRow,
	PageHeader,
	PullToRefresh,
	confirm,
	toast,
} from "../../ui";
import { abbreviateHomePath } from "../sessions/NewSessionSheet";
import { LoadGate } from "./PanelState";
import { useLoad, useResync } from "./hooks";

export interface ServiceInfo {
	pid: number;
	name: string;
	port: number;
	cwd: string | null;
	command: string;
	url?: string;
	sessionId: string | null;
	startedByApp: boolean;
	memoryKb: number | null;
}

function pathMatches(a: string, b: string): boolean {
	const normA = a.replace(/\/+$/, "");
	const normB = b.replace(/\/+$/, "");
	if (!normA || !normB) return false;
	return normA === normB || normA.startsWith(`${normB}/`) || normB.startsWith(`${normA}/`);
}

function isProjectService(s: ServiceInfo, sessionId: string, sessionCwd?: string | null): boolean {
	if (s.sessionId && s.sessionId === sessionId) return true;
	if (sessionCwd && s.cwd && pathMatches(s.cwd, sessionCwd)) return true;
	if (!sessionCwd && s.startedByApp) return true;
	return false;
}

function isSessionOwned(s: ServiceInfo, sessionId: string, sessionCwd?: string | null): boolean {
	if (s.sessionId && s.sessionId === sessionId) return true;
	return s.startedByApp && (!sessionCwd || !s.cwd || pathMatches(s.cwd, sessionCwd));
}

export function ServicesPanel({ sessionId, embedded = false, active = true }: { sessionId: string; embedded?: boolean; active?: boolean }) {
	const [diagOpen, setDiagOpen] = useState(false);
	const [stopping, setStopping] = useState<number | null>(null);
	const [menuTarget, setMenuTarget] = useState<{ service: ServiceInfo; anchor: HTMLElement | null } | null>(null);
	const session = useSession(sessionId);
	const byId = useSessions((s) => s.byId);
	const state = useLoad(
		(signal) => api<ServiceInfo[]>("GET", `/services?all=${diagOpen}`, undefined, { signal }),
		[diagOpen],
	);
	useResync(() => void state.reload(true));

	const stop = async (s: ServiceInfo) => {
		const ok = await confirm({
			title: "停止服务",
			message: `确定停止 ${s.name}？端口 ${s.port}，PID ${s.pid}。`,
			confirmText: "停止",
			danger: true,
		});
		if (!ok) return;
		setStopping(s.pid);
		try {
			await api("POST", `/services/${s.pid}/stop`);
			toast("已停止", { kind: "success" });
		} catch (e) {
			toast(`停止失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setStopping(null);
			void state.reload(true);
		}
	};

	const rows = state.data ?? [];
	const { projectRows, otherRows } = useMemo(() => {
		const project: ServiceInfo[] = [];
		const other: ServiceInfo[] = [];
		for (const s of rows) {
			if (isProjectService(s, sessionId, session?.cwd)) project.push(s);
			else other.push(s);
		}
		return { projectRows: project, otherRows: other };
	}, [rows, sessionId, session?.cwd]);

	const openInBrowser = (addr: string) => {
		window.open(addr, "_blank", "noopener,noreferrer");
	};

	const activeMenuService = menuTarget?.service ?? null;
	const activeMenuAddr = activeMenuService ? activeMenuService.url || `http://localhost:${activeMenuService.port}` : "";
	const activeMenuOwned = activeMenuService ? isSessionOwned(activeMenuService, sessionId, session?.cwd) : false;

	const body = (
		<PullToRefresh onRefresh={() => state.reload(true)}>
			<LoadGate state={state}>
				{() => (
					<div className="space-y-4 pt-3" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 24px)" }}>
						{projectRows.length === 0 ? (
							<EmptyState
								icon={<Server size={22} strokeWidth={1.75} />}
								title="当前项目暂无预览服务"
								hint="由 Agent 或本项目目录启动的本地开发服务器会显示在这里"
							/>
						) : (
							<ListGroup title={`运行中的服务 · ${projectRows.length}`}>
								{projectRows.map((s) => {
									const sess = s.sessionId ? byId[s.sessionId] : undefined;
									const owner = sess ? sessionName(sess) : null;
									const addr = s.url || `http://localhost:${s.port}`;
									const metaParts = [addr];
									if (s.cwd) metaParts.push(abbreviateHomePath(s.cwd));
									if (owner) metaParts.push(`来自 ${owner}`);
									if (s.memoryKb) metaParts.push(`${Math.round(s.memoryKb / 1024)} MB`);
									return (
										<div key={`${s.pid}:${s.port}`} className="m-list-row flex items-center gap-2 py-2.5 pr-2 pl-4">
											<button
												type="button"
												onClick={() => openInBrowser(addr)}
												className="min-w-0 flex-1 text-left active:opacity-75"
											>
												<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
													<span className="inline-block h-2 w-2 shrink-0 self-center rounded-full bg-m-success" aria-hidden />
													<span className="text-m-md font-medium break-words text-m-text">{s.name}</span>
													<span className="font-m-mono text-m-xs whitespace-nowrap text-m-accent">:{s.port}</span>
												</div>
												<div className="mt-1 pl-4 font-m-mono text-[12px] leading-relaxed break-all text-m-text-3">
													{metaParts.join(" · ")}
												</div>
											</button>
											<IconButton
												variant="plain"
												size="sm"
												icon={<MoreHorizontal size={18} strokeWidth={1.75} />}
												label={`操作 ${s.name}`}
												disabled={stopping === s.pid}
												onClick={(e) => setMenuTarget({ service: s, anchor: e.currentTarget })}
											/>
										</div>
									);
								})}
							</ListGroup>
						)}

						<ListGroup>
							<button
								type="button"
								aria-expanded={diagOpen}
								onClick={() => setDiagOpen((v) => !v)}
								className="m-list-row flex min-h-11 w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-m-sm font-medium text-m-text-2 active:bg-m-surface-hover"
							>
								<span className="whitespace-nowrap">
									本机其他端口（诊断）
									{diagOpen && otherRows.length > 0 ? ` · ${otherRows.length}` : ""}
								</span>
								{diagOpen ? <ChevronDown size={17} className="shrink-0 text-m-text-3" /> : <ChevronRight size={17} className="shrink-0 text-m-text-3" />}
							</button>
							{diagOpen &&
								(otherRows.length === 0 ? (
									<div className="px-4 py-3 text-m-xs text-m-text-3">没有检测到其他监听端口</div>
								) : (
									otherRows.map((s) => (
										<div key={`other-${s.pid}:${s.port}`} className="m-list-row space-y-1 px-4 py-2.5">
											<div className="flex flex-wrap items-baseline justify-between gap-2">
												<span className="text-m-sm font-medium break-words text-m-text">{s.name}</span>
												<span className="font-m-mono text-m-xs whitespace-nowrap text-m-text-3">
													:{s.port} · PID {s.pid}
												</span>
											</div>
											<div className="m-selectable font-m-mono text-m-xs break-all text-m-text-3">{s.command}</div>
										</div>
									))
								))}
						</ListGroup>

						<AnchoredPopover
							open={active && activeMenuService !== null}
							onClose={() => setMenuTarget(null)}
							anchorEl={menuTarget?.anchor}
							placement="bottom-end"
							ariaLabel="服务操作"
							minWidth={196}
						>
							{activeMenuService && (
								<>
									<MenuRow
										icon={<ExternalLink size={17} strokeWidth={1.75} />}
										label="在浏览器打开"
										onClick={() => {
											const addr = activeMenuAddr;
											setMenuTarget(null);
											openInBrowser(addr);
										}}
									/>
									<MenuRow
										icon={<Copy size={17} strokeWidth={1.75} />}
										label="复制本机地址"
										onClick={() => {
											const addr = activeMenuAddr;
											setMenuTarget(null);
											void copyText(addr).then((ok) => ok && toast("已复制本机地址", { kind: "success" }));
										}}
									/>
									{activeMenuService.cwd && (
										<MenuRow
											icon={<FolderOpen size={17} strokeWidth={1.75} />}
											label="复制目录"
											onClick={() => {
												const dir = activeMenuService.cwd ?? "";
												setMenuTarget(null);
												void copyText(dir).then((ok) => ok && toast("已复制目录", { kind: "success" }));
											}}
										/>
									)}
									{activeMenuOwned && (
										<MenuRow
											icon={<Square size={16} strokeWidth={1.75} />}
											label="停止服务"
											danger
											onClick={() => {
												const svc = activeMenuService;
												setMenuTarget(null);
												void stop(svc);
											}}
										/>
									)}
								</>
							)}
						</AnchoredPopover>
					</div>
				)}
			</LoadGate>
		</PullToRefresh>
	);

	if (embedded) return <div className="flex h-full min-h-0 flex-1 flex-col bg-m-bg">{body}</div>;

	return (
		<div className="flex h-full flex-col bg-m-bg">
			<PageHeader title="服务" subtitle="项目预览与本地端口" onBack={() => nav.back()} />
			{body}
		</div>
	);
}

export function ServicesPage({ route }: PageProps) {
	return <ServicesPanel sessionId={route.params.id} />;
}
