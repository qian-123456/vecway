import { AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, errorMessage } from "../../core/api";
import { compactNumber } from "../../core/lib/format";
import type { PageProps } from "../../core/nav";
import { normalizeTranscript } from "../../core/normalize";
import type { Item } from "../../core/types";
import { Button, confirm, EmptyState, ListGroup, PageHeader, PullToRefresh, Spinner, toast } from "../../ui";
import { Markdown } from "../../ui/Markdown";
import { Thinking } from "../chat/components/Thinking";
import { ToolCard, toolState } from "../chat/components/ToolCard";
import { elapsedMs, formatElapsed, rowLabel, statusBucket, statusText } from "./model";
import { BUCKET_DOT } from "./SubagentTree";
import { refreshSubagents } from "./store";
import { useSubagentTranscript } from "./transcript";
import { useNow } from "./useNow";

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="pt-5">
			<h2 className="px-4 pb-2 text-m-xs font-medium whitespace-nowrap text-m-text-3">{title}</h2>
			{children}
		</section>
	);
}

/** Stacked Apple-style overview row: label above full wrapping value. */
function StackRow({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="m-list-row pl-4">
			<div className="m-list-sep py-2.5 pr-4">
				<div className="text-[11.5px] font-medium whitespace-nowrap text-m-text-3">{label}</div>
				<div className="m-selectable mt-0.5 text-m-sm leading-relaxed break-words [overflow-wrap:anywhere] text-m-text">
					{children}
				</div>
			</div>
		</div>
	);
}

function ToolDisclosure({ label, defaultOpen, children }: { label: string; defaultOpen: boolean; children: ReactNode }) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className="min-w-0">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex min-h-9 items-center gap-1.5 text-m-xs font-medium text-m-text-3 active:opacity-70"
			>
				<span>{label}</span>
				{open ? <ChevronDown size={14} strokeWidth={1.75} aria-hidden /> : <ChevronRight size={14} strokeWidth={1.75} aria-hidden />}
			</button>
			{open && <div className="mt-1 space-y-2">{children}</div>}
		</div>
	);
}

function Message({
	item,
	running,
	agentId,
}: {
	item: Item;
	running: boolean;
	agentId: string;
}) {
	if (item.role === "system") {
		return item.text ? <p className="px-1 text-m-xs break-words text-m-text-3">{item.text}</p> : null;
	}
	if (item.role === "user") {
		return (
			<div className="m-selectable ml-auto max-w-[85%] rounded-m-lg bg-m-bubble-user-bg px-[18px] py-3 text-m-md [overflow-wrap:anywhere] whitespace-pre-wrap text-m-bubble-user-text">
				{item.text}
			</div>
		);
	}
	const hasTools = item.tools.length > 0;
	const hasToolAttention = item.tools.some((t) => {
		const st = toolState(t, running);
		return st === "run" || st === "bad";
	});
	return (
		<div className="min-w-0 space-y-2">
			{hasTools ? (
				<ToolDisclosure
					label={hasToolAttention && running ? "处理中" : "已处理"}
					defaultOpen={hasToolAttention || !item.text}
				>
					{item.thinking && (
						<Thinking
							id={`sub-${agentId}-${item.id}`}
							text={item.thinking}
							live={running && !item.text}
						/>
					)}
					{item.tools.map((t) => (
						<ToolCard key={t.id} id={`sub-${agentId}-${t.id}`} tool={t} state={toolState(t, running)} />
					))}
				</ToolDisclosure>
			) : (
				item.thinking && (
					<Thinking
						id={`sub-${agentId}-${item.id}`}
						text={item.thinking}
						live={running && !item.text}
					/>
				)
			)}
			{item.text && (
				<div className="m-selectable py-0.5">
					<Markdown text={item.text} streaming={running} />
				</div>
			)}
		</div>
	);
}

function PromptCard({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const long = text.length > 400 || text.split("\n").length > 8;
	return (
		<div className="rounded-m-lg bg-m-surface px-4 py-3">
			<div className={`m-selectable ${!open && long ? "max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : ""}`}>
				<Markdown text={text} />
			</div>
			{long && (
				<Button variant="ghost" className="-ml-3 mt-1" onClick={() => setOpen((v) => !v)}>
					{open ? "收起" : "展开全部"}
				</Button>
			)}
		</div>
	);
}

export function SubagentDetailPage({ route }: PageProps) {
	const { id: sessionId, agentId } = route.params;
	const { info, items, loading, error, refresh } = useSubagentTranscript(sessionId, agentId);
	const summary = info?.summary;
	const bucket = statusBucket(summary?.status);
	const running = !!summary && (bucket === "running" || bucket === "queued");
	const [stopBusy, setStopBusy] = useState(false);
	const [stopError, setStopError] = useState<string | null>(null);
	const stopContext = useRef<{ active: boolean; busy: boolean; controller: AbortController | null }>({ active: false, busy: false, controller: null });
	useEffect(() => {
		const context = { active: true, busy: false, controller: null as AbortController | null };
		stopContext.current = context;
		setStopBusy(false);
		setStopError(null);
		const onVisibility = () => {
			if (document.visibilityState === "hidden") context.controller?.abort();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			context.active = false;
			document.removeEventListener("visibilitychange", onVisibility);
			context.controller?.abort();
		};
	}, [sessionId, agentId]);
	const stopTurn = async () => {
		const context = stopContext.current;
		if (!running || !context.active || context.busy) return;
		context.busy = true;
		setStopBusy(true);
		setStopError(null);
		try {
			const accepted = await confirm({
				title: "停止当前回合？",
				message: "这会停止父会话的当前回合，以及该回合中所有受影响的子代理工作，不是仅停止当前子代理。",
				confirmText: "停止当前回合",
				cancelText: "继续运行",
				danger: true,
			});
			if (!accepted || !context.active || document.visibilityState === "hidden") return;
			const controller = new AbortController();
			context.controller = controller;
			const result = await api<{ ok: boolean }>("POST", `/sessions/${encodeURIComponent(sessionId)}/abort`, undefined, { signal: controller.signal });
			if (!context.active || controller.signal.aborted) return;
			if (!result?.ok) throw new Error("停止请求未被确认，请重试");
			toast("已发送停止请求");
			void refreshSubagents(sessionId);
			await refresh();
		} catch (error) {
			if (context.active && !context.controller?.signal.aborted) setStopError(errorMessage(error, "停止失败，请重试"));
		} finally {
			context.busy = false;
			context.controller = null;
			if (context.active) setStopBusy(false);
		}
	};
	const now = useNow(running);
	const label = rowLabel(summary ?? { id: agentId, status: "running" });
	const messages = useMemo(() => {
		const all = normalizeTranscript(items);
		// Hide only the assignment duplicated by the task card, never a later followup.
		const first = all.findIndex((i) => i.role === "user");
		return info?.prompt && first >= 0 && all[first].text.trim() === info.prompt.trim()
			? all.filter((_, i) => i !== first)
			: all;
	}, [items, info?.prompt]);
	const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.text)?.text ?? "";
	const rawOutput = info?.output?.trim() ?? "";
	const lastToolError = [...messages]
		.reverse()
		.flatMap((m) => [...m.tools].reverse())
		.find((t) => t.status === "error")?.result;
	// A failed agent's output (or its last tool error) is the error text, shown in full once.
	const errorText = bucket === "failed" ? rawOutput || lastToolError || "" : "";
	const output = rawOutput && rawOutput !== lastAssistant.trim() && rawOutput !== errorText ? rawOutput : "";
	const elapsed = summary ? formatElapsed(elapsedMs(summary, now)) : "";
	const usage = summary
		? [
				summary.tokens != null ? `${compactNumber(summary.tokens)} 词元` : "— 词元",
				summary.requestCount ? `${summary.requestCount} 次请求` : "",
				summary.toolCallCount ? `${summary.toolCallCount} 次工具调用` : "",
				summary.cost != null ? `$${summary.cost.toFixed(3)}` : "—",
			].filter(Boolean)
		: [];

	return (
		<div className="flex h-full flex-col bg-m-bg">
			<PageHeader
				title={summary ? label.primary : "子代理详情"}
				subtitle={summary ? [statusText(summary.status), elapsed].filter(Boolean).join(" · ") : undefined}
			/>
			<PullToRefresh className="min-h-0 flex-1" onRefresh={refresh}>
				{!info && loading ? (
					<div className="flex justify-center py-12 text-m-text-3">
						<Spinner size={22} />
					</div>
				) : !info || !summary ? (
					<EmptyState title="加载失败" hint={error ?? "找不到这个子代理"} action={<Button onClick={() => void refresh()}>重新加载</Button>} />
				) : (
					<div className="pb-8" style={{ paddingBottom: running ? "24px" : "calc(var(--m-safe-bottom) + 28px)" }}>
						{error && <p className="px-4 pt-3 text-m-xs break-words text-m-danger">刷新失败：{error}</p>}
						{stopError && <p role="alert" className="px-4 pt-3 text-m-sm [overflow-wrap:anywhere] text-m-danger">停止失败：{stopError}</p>}

						{bucket === "failed" && (
							<div role="alert" className="mx-4 mt-3 rounded-m-lg bg-m-danger-bg px-4 py-3.5 text-m-danger">
								<div className="flex items-center gap-2 text-m-md font-medium">
									<AlertCircle size={20} strokeWidth={1.75} />
									<span>{statusText(summary.status) === "已中止" ? "子代理已中止" : "子代理执行失败"}</span>
								</div>
								{errorText && (
									<pre className="m-selectable m-0 mt-2 font-m-mono text-m-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">{errorText}</pre>
								)}
							</div>
						)}

						<Section title="概览">
							<ListGroup>
								<StackRow label="状态">
									<span className="inline-flex items-center gap-2">
										<span aria-hidden className={`size-2 rounded-m-pill ${BUCKET_DOT[bucket]}`} />
										<span>{statusText(summary.status)}</span>
									</span>
								</StackRow>
								{label.role && <StackRow label="角色">{label.role}</StackRow>}
								{summary.model && (
									<StackRow label="模型">
										<span className="font-m-mono text-[13px]">
											{summary.model}
											{summary.thinkingLevel ? ` · ${summary.thinkingLevel}` : ""}
										</span>
									</StackRow>
								)}
								{elapsed && <StackRow label="耗时">{elapsed}</StackRow>}
								{usage.length > 0 && <StackRow label="用量">{usage.join(" · ")}</StackRow>}
								<StackRow label="编号">
									<span className="font-m-mono text-m-xs">{summary.id}</span>
								</StackRow>
							</ListGroup>
						</Section>

						{(info.prompt || label.description) && (
							<Section title="任务要求">
								<div className="px-4">
									<PromptCard text={info.prompt || label.description} />
								</div>
							</Section>
						)}

						<Section title="执行过程">
							<div className="px-4">
								{messages.length === 0 ? (
									<div className="rounded-m-lg bg-m-surface px-4 py-6 text-center text-m-sm text-m-text-3">
										{running ? "子代理刚启动，还没有输出" : "没有执行记录"}
									</div>
								) : (
									<div className="flex flex-col gap-4">
										{messages.map((m, index) => (
											<Message
												key={m.id}
												item={m}
												agentId={agentId}
												running={bucket === "running" && index === messages.length - 1}
											/>
										))}
									</div>
								)}
							</div>
						</Section>

						{!running && output && (
							<Section title="产出">
								<div className="px-4">
									<div className="m-selectable rounded-m-lg bg-m-surface px-4 py-3">
										<Markdown text={output} />
									</div>
								</div>
							</Section>
						)}
					</div>
				)}
			</PullToRefresh>
			{running && (
				<div
					className="shrink-0 border-t border-m-border/75 bg-m-bg-elev/90 px-4 pt-2.5 backdrop-blur-xl"
					style={{ paddingBottom: "calc(var(--m-safe-bottom) + 10px)" }}
				>
					<Button variant="danger" block busy={stopBusy} onClick={() => void stopTurn()}>
						停止当前回合
					</Button>
				</div>
			)}
		</div>
	);
}
