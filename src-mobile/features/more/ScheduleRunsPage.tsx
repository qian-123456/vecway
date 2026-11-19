import { History, MessageSquare } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../../core/api";
import { nav, paths } from "../../core/nav";
import type { PageProps } from "../../core/nav";
import { Button, Chip, confirm, EmptyState, ListGroup, ListRow, PageHeader, PullToRefresh, toast } from "../../ui";
import { LoadState, useLoad } from "./controls";
import { fmtTime, RUN_STATUS_LABEL, runDurationText, runTone } from "./schedule";
import type { Schedule, ScheduleRun } from "./schedule";

export function ScheduleRunsPage({ route }: PageProps) {
	const id = route.params.id ?? "";
	const runs = useLoad(() => api<ScheduleRun[]>("GET", `/left/schedules/${encodeURIComponent(id)}/runs?limit=50`), [id]);
	const sched = useLoad(async () => (await api<Schedule[]>("GET", "/left/schedules")).find((s) => s.id === id) ?? null, [id]);
	const awaiting = useLoad(() => api<ScheduleRun[]>("GET", `/left/schedules/${encodeURIComponent(id)}/awaiting`), [id]);
	const [busyRun, setBusyRun] = useState<{ id: string; action: "resume" | "release" } | null>(null);

	const resume = async (run: ScheduleRun) => {
		setBusyRun({ id: run.id, action: "resume" });
		try {
			await api("POST", `/left/schedules/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.id)}/resume-awaiting`);
			toast("已继续等待中的运行", { kind: "success" });
		} catch (e) {
			toast(`继续运行失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			await Promise.all([awaiting.reload(), runs.reload(), sched.reload()]);
			setBusyRun(null);
		}
	};

	const release = async (run: ScheduleRun) => {
		if (!(await confirm({
			title: "解除等待确认",
			message: "解除后原运行将标记为失败，后续排队任务会继续。此操作不会停止原会话，原会话可能与后续任务同时运行。确定解除吗？",
			confirmText: "确认解除",
			danger: true,
		}))) return;
		setBusyRun({ id: run.id, action: "release" });
		try {
			await api("POST", `/left/schedules/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.id)}/release-awaiting`);
			toast("已解除等待确认", { kind: "success" });
		} catch (e) {
			toast(`解除失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			await Promise.all([awaiting.reload(), runs.reload(), sched.reload()]);
			setBusyRun(null);
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-m-bg-elev text-m-text">
			<PageHeader title="运行记录" subtitle={sched.data?.name} className="bg-m-bg-elev!" />
			<PullToRefresh onRefresh={() => Promise.all([runs.reload(), sched.reload(), awaiting.reload()])}>
				{awaiting.data === null ? (
					<LoadState loading={awaiting.loading} error={awaiting.error} onRetry={awaiting.reload} />
				) : (
					<>
						{awaiting.error && <p className="m-selectable px-8 pt-2 text-m-sm break-words text-m-danger">刷新等待确认记录失败：{awaiting.error} <Button size="sm" variant="ghost" onClick={() => void awaiting.reload()}>重试</Button></p>}
						{!awaiting.error && !awaiting.loading && awaiting.data.length > 0 && (
							<ListGroup title="等待确认" note="继续运行会尝试恢复原会话；解除等待不会停止原会话，请先确认是否允许后续任务继续。">
								{awaiting.data.map((r) => (
									<ListRow
										key={r.id}
										title={fmtTime(r.startedAt)}
										subtitle={r.summary || "等待人工确认"}
										right={
											<div className="flex flex-wrap justify-end gap-2">
												<Button size="sm" busy={busyRun?.id === r.id && busyRun.action === "resume"} disabled={busyRun !== null} onClick={() => void resume(r)}>继续运行</Button>
												<Button size="sm" variant="danger" busy={busyRun?.id === r.id && busyRun.action === "release"} disabled={busyRun !== null} onClick={() => void release(r)}>解除等待</Button>
											</div>
										}
									/>
								))}
							</ListGroup>
						)}
					</>
				)}
				{runs.data === null ? (
					<LoadState loading={runs.loading} error={runs.error} onRetry={runs.reload} />
				) : runs.data.length === 0 ? (
					<EmptyState className="min-h-[70dvh]" icon={<History size={26} strokeWidth={1.75} />} title="暂无运行记录" hint="任务运行后会显示在这里" />
				) : (
					<div className="pt-2" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 24px)" }}>
						<ListGroup note="有会话的记录可轻点打开">
							{runs.data.map((r) => {
								const dur = runDurationText(r);
								const sid = r.sessionId;
								return (
									<ListRow
										key={r.id}
										title={
											<span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="run-row">
												<span className="whitespace-nowrap">{fmtTime(r.startedAt)}</span>
												<Chip tone={runTone(r.status)}>{RUN_STATUS_LABEL[r.status] ?? r.status}</Chip>
											</span>
										}
										subtitle={
											dur || r.summary ? (
												<>
													{dur && <span className="block">{dur}</span>}
													{r.summary && <span className="m-selectable mt-1 block text-m-sm whitespace-pre-wrap text-m-text-2">{r.summary}</span>}
												</>
											) : undefined
										}
										right={sid ? <MessageSquare size={18} strokeWidth={1.75} aria-label="打开会话" /> : undefined}
										chevron={!!sid}
										onClick={sid ? () => nav.push(paths.chat(sid)) : undefined}
									/>
								);
							})}
						</ListGroup>
					</div>
				)}
			</PullToRefresh>
		</div>
	);
}
