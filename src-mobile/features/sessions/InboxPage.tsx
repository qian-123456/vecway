import { CheckCheck, Inbox } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, errorMessage } from "../../core/api";
import { nav, paths, type PageProps } from "../../core/nav";
import { relTime, sessionName } from "../../core/lib/format";
import { events } from "../../core/sse";
import { Button, EmptyState, ListGroup, PageHeader, PullToRefresh, Spinner, toast } from "../../ui";
import { rubberBand, VelocityTracker } from "../../ui/gesturePhysics";
import { prefersReducedMotion } from "../../ui/motion";
import { INBOX_TITLES, inboxSections, type InboxData } from "./inbox";
import { STATUS_DOT, statusLine } from "./SessionRow";
import { TodosPane } from "./TodosPane";
import { openTodos, startTodosSync, useTodos } from "./todos";
import type { TreeSession } from "./tree";
import { refreshAll } from "./treeStore";

/** Swipe right to read; the action sheet provides the same keyboard-accessible action. */
function InboxRow({ s, onOpen, onSeen }: { s: TreeSession; onOpen: () => void; onSeen?: () => Promise<void> }) {
	const [reading, setReading] = useState(false);
	const rowRef = useRef<HTMLDivElement>(null);
	const trackerRef = useRef(new VelocityTracker());
	const pending = useRef(false);
	const suppressClickUntil = useRef(0);
	const gesture = useRef<{ id: number; x: number; y: number; dx: number; axis: "x" | "y" | null } | null>(null);
	const st = s.status || "idle";
	const line = [statusLine(s), relTime(s.updatedAt)].filter(Boolean).join(" · ");
	const markRead = async () => {
		if (!onSeen || pending.current) return;
		pending.current = true;
		setReading(true);
		try {
			await onSeen();
		} finally {
			pending.current = false;
			setReading(false);
		}
	};
	const applySwipe = (px: number, animate: boolean) => {
		const row = rowRef.current;
		if (!row) return;
		row.style.transition = animate && !prefersReducedMotion() ? "transform var(--m-dur-fast) var(--m-ease)" : "none";
		row.style.transform = px !== 0 ? `translate3d(${px}px,0,0)` : "";
	};
	const finishSwipe = (e: ReactPointerEvent<HTMLDivElement>) => {
		const g = gesture.current;
		if (!g || g.id !== e.pointerId) return;
		gesture.current = null;
		const { vx } = trackerRef.current.velocity(e.timeStamp);
		trackerRef.current.reset();
		applySwipe(0, true);
		if (g.axis) suppressClickUntil.current = Date.now() + 500;
		if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
		if (e.type === "pointerup" && g.axis === "x" && (g.dx >= 80 || vx >= 0.45)) void markRead();
	};
	return (
			<div
				className="m-list-row relative overflow-hidden"
				style={{ touchAction: "pan-y pinch-zoom" }}
				onPointerDown={(e) => {
					if (!onSeen || pending.current || !e.isPrimary || e.button !== 0 || (e.target as HTMLElement).closest("[data-inbox-actions]")) return;
					suppressClickUntil.current = 0;
					trackerRef.current.reset();
					trackerRef.current.add(e.clientX, e.clientY, e.timeStamp);
					gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, axis: null };
				}}
				onPointerMove={(e) => {
					const g = gesture.current;
					if (!g || g.id !== e.pointerId) return;
					const dx = e.clientX - g.x;
					const dy = e.clientY - g.y;
					if (!g.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 10) {
						g.axis = dx > 0 && dx > Math.abs(dy) * 1.3 ? "x" : "y";
						suppressClickUntil.current = Date.now() + 500;
						if (g.axis === "x") e.currentTarget.setPointerCapture(e.pointerId);
					}
					if (g.axis !== "x") return;
					e.preventDefault();
					trackerRef.current.add(e.clientX, e.clientY, e.timeStamp);
					g.dx = Math.max(0, dx);
					const clamped = g.dx <= 112 ? g.dx : 112 + rubberBand(g.dx - 112, 80, 0.45);
					applySwipe(clamped, false);
				}}
				onPointerUp={finishSwipe}
				onPointerCancel={finishSwipe}
				onLostPointerCapture={finishSwipe}
				onClickCapture={(e) => {
					if (e.detail !== 0 && Date.now() < suppressClickUntil.current) { e.preventDefault(); e.stopPropagation(); }
				}}
			>
				{onSeen && <div aria-hidden className="absolute inset-y-0 left-0 flex w-28 items-center justify-center gap-2 bg-m-accent-soft text-m-sm whitespace-nowrap text-m-accent-soft-text"><CheckCheck size={20} />已读</div>}
				<div ref={rowRef} className="relative flex items-stretch bg-m-card pl-4">
					<span aria-hidden className="flex w-6 shrink-0 items-center justify-center">
						<span className={`size-2.5 rounded-m-pill ${STATUS_DOT[st] ?? "bg-m-surface-2"}`} />
					</span>
					<span className="m-list-sep ml-4 flex min-w-0 flex-1 items-center gap-2 pr-3">
						<button type="button" onClick={onOpen} className="min-h-14 min-w-11 flex-1 py-3 text-left active:bg-m-surface-hover">
							<span className="block text-m-md break-words text-m-text">{sessionName(s)}</span>
							{line && <span className="mt-0.5 block text-m-xs break-words text-m-text-3">{line}</span>}
						</button>
						{onSeen && (
							<span data-inbox-actions className="shrink-0">
								<button
									type="button"
									disabled={reading}
									aria-busy={reading || undefined}
									aria-label={`标记已读：${sessionName(s)}`}
									onClick={() => void markRead()}
									className="m-press relative inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-[10px] border border-m-border bg-m-surface px-4 text-m-sm font-medium whitespace-nowrap text-m-text active:bg-m-surface-2 disabled:opacity-40"
								>
									{reading ? <Spinner size={16} /> : null}
									已读
								</button>
							</span>
						)}
					</span>
				</div>
			</div>
	);
}

export function InboxPage(_props: PageProps) {
	const [data, setData] = useState<InboxData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [readingAll, setReadingAll] = useState(false);
	const readPending = useRef(false);
	const todoCount = useTodos((s) => openTodos(s.todos).length);
	const todosReady = useTodos((s) => s.loaded && !s.error);
	const alive = useRef(true);

	const load = useCallback(async () => {
		try {
			const d = await api<InboxData>("GET", "/left/inbox");
			if (!alive.current) return;
			setData(d);
			setError(null);
		} catch (e) {
			if (alive.current) setError(errorMessage(e));
		}
	}, []);

	useEffect(() => {
		alive.current = true;
		void load();
		const offTodos = startTodosSync();
		let t: ReturnType<typeof setTimeout> | undefined;
		const soon = () => {
			clearTimeout(t);
			t = setTimeout(() => void load(), 400);
		};
		const offs = [events.on("session", soon), events.on("hello", soon), events.on("resync", soon)];
		return () => {
			alive.current = false;
			clearTimeout(t);
			offTodos();
			offs.forEach((o) => o());
		};
	}, [load]);

	const seen = useCallback(
		async (s: TreeSession) => {
			try {
				await api("POST", `/left/inbox/${encodeURIComponent(s.id)}/seen`);
				await Promise.all([load(), refreshAll()]);
			} catch (e) {
				toast(`操作失败：${errorMessage(e)}`, { kind: "error" });
			}
		},
		[load],
	);

	const readAll = async () => {
		if (readPending.current) return;
		readPending.current = true;
		setReadingAll(true);
		try {
			const r = await api<{ count?: number }>("POST", "/left/inbox/read-all");
			toast(`已将 ${r.count ?? 0} 个会话标为已读`, { kind: "success" });
			await Promise.all([load(), refreshAll()]);
		} catch (e) {
			toast(`操作失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			readPending.current = false;
			if (alive.current) setReadingAll(false);
		}
	};

	const sections = data ? inboxSections(data) : [];
	const canReadAll = !!data && ((data.unread?.length ?? 0) > 0 || (data.error?.length ?? 0) > 0);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-m-bg-elev">
			<PageHeader
				title="收件箱"
				className="bg-m-bg-elev!"
				right={
					canReadAll ? (
						<Button
							size="sm"
							className="min-h-11"
							variant="ghost"
							busy={readingAll}
							onClick={() => void readAll()}
						>
							全部已读
						</Button>
					) : undefined
				}
			/>
			<PullToRefresh
				onRefresh={() => Promise.allSettled([load(), useTodos.getState().load()])}
				className="pb-[calc(var(--m-safe-bottom)+24px)]"
			>
				<div className="m-kb-pad">
				{error && <div role="alert" className="flex flex-col items-center gap-4 px-6 py-6 text-center"><p className="m-selectable text-m-sm break-words text-m-danger">加载失败：{error}</p><Button onClick={() => void load()}>重试</Button></div>}
				{!data && !error && (
					<div role="status" aria-label="加载收件箱" className="flex justify-center p-10 text-m-text-3">
						<Spinner size={20} />
					</div>
				)}
				<TodosPane />
				{data && !error && todosReady && sections.length === 0 && todoCount === 0 && (
					<EmptyState
						icon={<Inbox size={26} strokeWidth={1.75} />}
						title="收件箱是空的"
						hint="等待审批或回答的会话、出错或中断的会话、已完成但未查看的会话、运行中会话及自动化待办会出现在这里"
					/>
				)}
				{sections.map(({ key, items }) => {
					const markable = key === "unread" || key === "error" || key === "interrupted";
					return (
						<div key={key} data-sec={key}>
							<ListGroup title={`${INBOX_TITLES[key] ?? key} · ${items.length}`}>
								{items.map((s) => (
									<InboxRow
										key={s.id}
										s={s}
										onOpen={() => {
											if (markable) void seen(s);
											nav.push(paths.chat(s.id));
										}}
										onSeen={markable ? () => seen(s) : undefined}
									/>
								))}
							</ListGroup>
						</div>
					);
				})}
				</div>
			</PullToRefresh>
		</div>
	);
}
