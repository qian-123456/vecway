import { ChevronDown, ChevronRight, ExternalLink, Server } from "lucide-react";
import { useMemo, useState } from "react";
import { api, errorMessage } from "../../core/api";
import { copyText, sessionName } from "../../core/lib/format";
import { nav, type PageProps } from "../../core/nav";
import { useSession, useSessions } from "../../core/stores/sessions";
import { Button, Chip, EmptyState, ListGroup, PageHeader, PullToRefresh, confirm, toast } from "../../ui";
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

export function ServicesPanel({ sessionId, embedded = false }: { sessionId: string; embedded?: boolean }) {
	const [diagOpen, setDiagOpen] = useState(false);
	const [stopping, setStopping] = useState<number | null>(null);
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

	const body = (
		<PullToRefresh onRefresh={() => state.reload(true)}>
			<LoadGate state={state}>
				{() => (
					<div className="space-y-4 px-4 pt-3" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 24px)" }}>
						{projectRows.length === 0 ? (
							<EmptyState
								icon={<Server size={22} strokeWidth={1.75} />}
								title="当前项目暂无预览服务"
								hint="由 Agent 或本项目目录启动的本地开发服务器会显示在这里"
							/>
						) : (
							<ListGroup className="!mx-0">
								{projectRows.map((s) => {
									const owned = isSessionOwned(s, sessionId, session?.cwd);
									const sess = s.sessionId ? byId[s.sessionId] : undefined;
									const owner = sess ? sessionName(sess) : null;
									const addr = s.url || `http://localhost:${s.port}`;
									return (
										<div key={`${s.pid}:${s.port}`} className="m-list-row space-y-2.5 px-4 py-3.5">
											<div className="flex items-start justify-between gap-2">
												<div className="min-w-0 flex-1">
													<div className="flex flex-wrap items-center gap-1.5">
														<Chip tone="success">
															<span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />
															运行中
														</Chip>
														<Chip tone="accent">:{s.port}</Chip>
														{s.startedByApp && <Chip>应用启动</Chip>}
													</div>
													<div className="mt-1.5 text-m-md font-medium break-all text-m-text">{s.name}</div>
												</div>
												{owned && (
													<Button
														variant="danger"
														size="sm"
														busy={stopping === s.pid}
														onClick={() => void stop(s)}
													>
														停止
													</Button>
												)}
											</div>
											<div className="flex flex-wrap items-center gap-2 text-m-xs text-m-text-2">
												<button
													type="button"
													onClick={() => void copyText(addr).then((ok) => ok && toast("已复制地址", { kind: "success" }))}
													className="inline-flex min-h-8 items-center gap-1 rounded-m-pill bg-m-surface px-2.5 font-m-mono text-m-xs text-m-accent active:bg-m-surface-2"
												>
													<ExternalLink size={12} />
													{addr}
												</button>
												{s.memoryKb ? <span className="whitespace-nowrap text-m-text-3">{Math.round(s.memoryKb / 1024)} MB</span> : null}
												{owner && <span className="truncate text-m-text-3">来自：{owner}</span>}
											</div>
											{s.cwd && (
												<div className="m-selectable truncate font-m-mono text-m-xs text-m-text-3">
													{abbreviateHomePath(s.cwd)}
												</div>
											)}
										</div>
									);
								})}
							</ListGroup>
						)}

						<div className="rounded-m-lg border border-m-border bg-m-card">
							<button
								type="button"
								aria-expanded={diagOpen}
								onClick={() => setDiagOpen((v) => !v)}
								className="flex min-h-11 w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-m-sm font-medium text-m-text-2 active:bg-m-surface-hover"
							>
								<span className="whitespace-nowrap">
									本机其他端口（诊断）
									{diagOpen && otherRows.length > 0 ? ` · ${otherRows.length}` : ""}
								</span>
								{diagOpen ? <ChevronDown size={17} className="shrink-0 text-m-text-3" /> : <ChevronRight size={17} className="shrink-0 text-m-text-3" />}
							</button>
							{diagOpen && (
								<div className="border-t border-m-border">
									{otherRows.length === 0 ? (
										<p className="px-4 py-3 text-m-xs text-m-text-3">没有检测到其他监听端口</p>
									) : (
										<div className="divide-y divide-m-border">
											{otherRows.map((s) => (
												<div key={`other-${s.pid}:${s.port}`} className="space-y-1 px-4 py-2.5">
													<div className="flex items-center justify-between gap-2">
														<span className="min-w-0 truncate text-m-sm font-medium text-m-text">{s.name}</span>
														<div className="flex shrink-0 items-center gap-1.5">
															<Chip>:{s.port}</Chip>
															<Chip>PID {s.pid}</Chip>
														</div>
													</div>
													<div className="m-selectable truncate font-m-mono text-m-xs text-m-text-3">{s.command}</div>
												</div>
											))}
										</div>
									)}
								</div>
							)}
						</div>
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
