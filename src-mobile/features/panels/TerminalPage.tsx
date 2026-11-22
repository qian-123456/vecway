import {
	ArrowLeft,
	Check,
	Eraser,
	Keyboard,
	MessageSquarePlus,
	MessagesSquare,
	Plus,
	RefreshCw,
	Sparkles,
	X,
} from "lucide-react";
import type { FitAddon as Fit } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api, apiUrl, errorMessage } from "../../core/api";
import { createEventSource } from "../../core/nativeBridge";
import { nav, paths, type PageProps } from "../../core/nav";
import { events, type EventSourceLike } from "../../core/sse";
import { isUnauthorized, useConnection } from "../../core/stores/connection";
import { Button, EmptyState, IconButton, PageHeader, confirm, inputCls, toast } from "../../ui";
import { useKeyboardOpen } from "../chat/components/ComposerToolbar";
import { abbreviateHomePath } from "../sessions/NewSessionSheet";
import { SIDECHAT_DRAFT_PREFIX } from "./SidechatPage";
import { useLayer } from "./hooks";
import { fenced } from "./pure";
import { useRightDrawer } from "./rightDrawerStore";
import {
	InputQueue,
	applyCtrl,
	decodeChunk,
	isTerminalGone,
	isTerminalLimit,
	parseExit,
	reconnectDelay,
	segmentTerminalBlocks,
	stripAnsi,
	type TerminalBlock,
} from "./terminalPure";

type Phase = "connecting" | "connected" | "reconnecting" | "dropped" | "exited" | "error";

const MAX_CAPTURE_CHARS = 120_000;

const COMPACT_SPECIAL_KEYS: ReadonlyArray<{ id: string; label: string; seq: string }> = [
	{ id: "tab", label: "Tab", seq: "\t" },
	{ id: "esc", label: "Esc", seq: "\x1b" },
	{ id: "up", label: "↑", seq: "\x1b[A" },
	{ id: "down", label: "↓", seq: "\x1b[B" },
	{ id: "ctrl-c", label: "Ctrl+C", seq: "\x03" },
];

function cssVar(name: string, fallback: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Follow active light/dark `--m-*` palette tokens without forcing pure black in light themes. */
function terminalColors(): { background: string; foreground: string; cursor: string } {
	const light = document.documentElement.dataset.scheme === "light";
	const background = cssVar(light ? "--m-card" : "--m-code-bg", cssVar("--m-bg", light ? "white" : "black"));
	const foreground = cssVar("--m-text", light ? "black" : "white");
	const cursor = cssVar("--m-accent", foreground);
	return { background, foreground, cursor };
}

function statusDisplay(phase: Phase, hasOutput: boolean): { label: string; tone: "ok" | "wait" | "bad" } {
	if (phase === "connected") {
		return hasOutput ? { label: "已就绪", tone: "ok" } : { label: "等待终端响应…", tone: "wait" };
	}
	if (phase === "connecting") return { label: "连接中", tone: "wait" };
	if (phase === "exited") return { label: "已退出", tone: "bad" };
	return { label: "输出流断开 · 重连", tone: "bad" };
}

export function TerminalPanel({
	sessionId,
	embedded = false,
	active: panelActive = true,
	visible = true,
}: {
	sessionId: string;
	embedded?: boolean;
	active?: boolean;
	visible?: boolean;
}) {
	const isPanelActive = panelActive && visible;
	const nextId = useRef(1);
	const [tabs, setTabs] = useState([1]);
	const tabsRef = useRef(tabs);
	const [active, setActive] = useState(1);

	const addTab = () => {
		if (tabsRef.current.length >= 4) {
			toast("最多同时打开 4 个终端，请先关闭一个终端", { kind: "error" });
			return;
		}
		const id = ++nextId.current;
		tabsRef.current = [...tabsRef.current, id];
		setTabs(tabsRef.current);
		setActive(id);
	};

	const removeTab = (id: number) => {
		const remaining = tabsRef.current.filter((tab) => tab !== id);
		tabsRef.current = remaining;
		setTabs(remaining);
		setActive((current) => (current === id ? remaining[remaining.length - 1] ?? 0 : current));
	};

	const tabBar = (
		<div className="flex shrink-0 items-center justify-between gap-2 border-b border-m-border px-3 py-1.5">
			<div role="tablist" aria-label="终端实例" className="m-noscrollbar flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
				{tabs.map((id) => (
					<button
						key={id}
						id={`terminal-tab-${id}`}
						type="button"
						role="tab"
						aria-selected={active === id}
						aria-controls={`terminal-pane-${id}`}
						onClick={() => setActive(id)}
						className={`min-h-8 shrink-0 rounded-m-pill px-3 text-m-xs font-medium whitespace-nowrap ${
							active === id ? "bg-m-accent-soft text-m-accent-soft-text" : "bg-m-surface text-m-text-2"
						}`}
					>
						终端 {id}
					</button>
				))}
			</div>
			{embedded && (
				<IconButton variant="filled" size="sm" icon={<Plus size={17} strokeWidth={2} />} label="新终端" onClick={addTab} />
			)}
		</div>
	);

	const body = (
		<div className="flex min-h-0 flex-1 flex-col bg-m-bg">
			{tabBar}
			{tabs.map((id) => (
				<TerminalPane
					key={id}
					sessionId={sessionId}
					tabId={id}
					active={active === id && isPanelActive}
					embedded={embedded}
					onClosed={() => removeTab(id)}
				/>
			))}
			{tabs.length === 0 && (
				<EmptyState
					title="终端已关闭"
					hint="新建终端会启动独立的真实终端进程"
					action={<Button onClick={addTab}>新终端</Button>}
				/>
			)}
		</div>
	);

	if (embedded) return body;

	return (
		<div className="flex h-full flex-col bg-m-bg">
			<PageHeader
				title="终端"
				onBack={() => nav.back()}
				right={<IconButton variant="filled" icon={<Plus size={22} strokeWidth={1.75} />} label="新终端" onClick={addTab} />}
			/>
			{body}
		</div>
	);
}

export function TerminalPage({ route }: PageProps) {
	return <TerminalPanel sessionId={route.params.id} />;
}

/** Each mounted pane owns one PTY; switching tabs or collapsing the drawer keeps that process alive. */
function TerminalPane({
	sessionId,
	tabId,
	active,
	embedded,
	onClosed,
}: {
	sessionId: string;
	tabId: number;
	active: boolean;
	embedded: boolean;
	onClosed: () => void;
}) {
	const activeRef = useRef(active);
	activeRef.current = active;
	const host = useRef<HTMLDivElement>(null);
	const term = useRef<XTerm | null>(null);
	const fit = useRef<Fit | null>(null);
	const termId = useRef<string | null>(null);
	const source = useRef<EventSourceLike | null>(null);
	const retries = useRef(0);
	const retryTimer = useRef(0);
	const exited = useRef(false);
	const alive = useRef(true);
	const authGeneration = useRef(0);
	const lastSize = useRef("");
	const queue = useRef<InputQueue | null>(null);
	const ctrlRef = useRef(false);
	const streamOpenRef = useRef(false);
	const decoderRef = useRef<TextDecoder | null>(null);
	const outputBufferRef = useRef("");

	const kbOpen = useKeyboardOpen();
	const [focused, setFocused] = useState(false);
	const [ctrl, setCtrlState] = useState(false);
	const [phase, setPhase] = useState<Phase>("connecting");
	const [detail, setDetail] = useState("");
	const [cwd, setCwd] = useState<string | null>(null);
	const [hasOutput, setHasOutput] = useState(false);
	const [streamOpen, setStreamOpen] = useState(false);
	const [bg, setBg] = useState<string | null>(null);

	const [selectMode, setSelectMode] = useState(false);
	const [blocks, setBlocks] = useState<TerminalBlock[]>([]);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
	const [comment, setComment] = useState("");

	const setCtrl = (v: boolean) => {
		ctrlRef.current = v;
		setCtrlState(v);
	};

	const setStreamState = (open: boolean) => {
		streamOpenRef.current = open;
		setStreamOpen(open);
	};

	const sendResize = useCallback(() => {
		const t = term.current;
		const id = termId.current;
		if (!t || !id) return;
		const key = `${t.cols}x${t.rows}`;
		if (key === lastSize.current) return;
		lastSize.current = key;
		api("POST", `/terminal/${id}/resize`, { cols: t.cols, rows: t.rows }).catch(() => {});
	}, []);

	const attach = useCallback(() => {
		const id = termId.current;
		if (!id || !alive.current || isUnauthorized()) return;
		source.current?.close();
		setStreamState(false);
		const es = createEventSource(apiUrl(`/terminal/${id}/stream`));
		source.current = es;
		es.onopen = () => {
			if (source.current !== es || isUnauthorized()) return;
			retries.current = 0;
			// The server replays its backlog on every (re)attach: reset terminal and capture buffer cleanly.
			term.current?.reset();
			outputBufferRef.current = "";
			decoderRef.current = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
			setHasOutput(false);
			setStreamState(true);
			setPhase("connected");
			setDetail("");
		};
		es.addEventListener("data", (ev) => {
			if (source.current !== es || isUnauthorized()) return;
			try {
				const bytes = decodeChunk(ev.data);
				term.current?.write(bytes);
				if (bytes.length > 0) setHasOutput(true);
				const decoded = decoderRef.current ? decoderRef.current.decode(bytes, { stream: true }) : String.fromCharCode(...bytes);
				if (decoded) {
					const next = outputBufferRef.current + decoded;
					outputBufferRef.current = next.length > MAX_CAPTURE_CHARS ? next.slice(next.length - MAX_CAPTURE_CHARS) : next;
				}
			} catch (err) {
				console.error("terminal data", err);
			}
		});
		es.addEventListener("exit", (ev) => {
			if (source.current !== es || isUnauthorized()) return;
			exited.current = true;
			setStreamState(false);
			es.close();
			if (source.current === es) source.current = null;
			const code = parseExit(ev.data);
			setPhase("exited");
			setDetail(code !== null ? `退出码 ${code}` : "");
		});
		es.onerror = (ev) => {
			if (source.current !== es || isUnauthorized()) return;
			if (exited.current || !alive.current) return;
			setStreamState(false);
			es.close();
			if (source.current === es) source.current = null;
			if (ev instanceof Error && ev.message === "channel_switched") {
				retries.current = 0;
				window.clearTimeout(retryTimer.current);
				if (!activeRef.current || document.visibilityState === "hidden") {
					setPhase("dropped");
					return;
				}
				setPhase("reconnecting");
				setDetail("");
				attach();
				return;
			}
			retries.current += 1;
			if (!activeRef.current || document.visibilityState === "hidden") {
				setPhase("dropped");
				return;
			}
			const delay = reconnectDelay(retries.current);
			if (delay === null) {
				setPhase("dropped");
				return;
			}
			setPhase("reconnecting");
			setDetail(`第 ${retries.current} 次`);
			window.clearTimeout(retryTimer.current);
			retryTimer.current = window.setTimeout(attach, delay);
		};
	}, []);

	const closeTerm = useCallback(async () => {
		const id = termId.current;
		if (id) await api("DELETE", `/terminal/${id}`);
		window.clearTimeout(retryTimer.current);
		source.current?.close();
		source.current = null;
		setStreamState(false);
		queue.current?.clear();
		termId.current = null;
	}, []);

	const open = useCallback(async () => {
		if (isUnauthorized()) return;
		const t = term.current;
		if (!t || !alive.current) return;
		const generation = authGeneration.current;
		exited.current = false;
		retries.current = 0;
		setHasOutput(false);
		setStreamState(false);
		setPhase("connecting");
		setDetail("");
		try {
			fit.current?.fit();
		} catch {
			/* host not laid out yet; defaults are used */
		}
		try {
			const res = await api<{ termId: string; cwd?: string }>("POST", "/terminal", { sessionId, cols: t.cols, rows: t.rows });
			if (isUnauthorized() || generation !== authGeneration.current) return;
			if (!alive.current) {
				api("DELETE", `/terminal/${res.termId}`).catch(() => {});
				return;
			}
			termId.current = res.termId;
			if (res.cwd) setCwd(res.cwd);
			lastSize.current = `${t.cols}x${t.rows}`;
			attach();
		} catch (e) {
			if (!alive.current || generation !== authGeneration.current) return;
			const msg = errorMessage(e, "打开失败");
			setPhase("error");
			setDetail(isTerminalLimit(msg) ? "终端数量已达上限（最多 4 个），请先关闭多余终端后点“新终端”" : msg);
		}
	}, [sessionId, attach]);

	const openNew = useCallback(async () => {
		try {
			await closeTerm();
			term.current?.reset();
			outputBufferRef.current = "";
			await open();
		} catch (e) {
			setPhase("error");
			setDetail(errorMessage(e, "重连失败"));
		}
	}, [closeTerm, open]);

	const handleClose = useCallback(async () => {
		const ok = await confirm({
			title: "关闭终端",
			message: "正在运行的命令会被结束。",
			confirmText: "关闭",
			danger: true,
		});
		if (!ok) return;
		try {
			await closeTerm();
			onClosed();
			toast("已关闭终端");
		} catch (e) {
			setDetail(`关闭失败：${errorMessage(e)}`);
			toast(`关闭失败：${errorMessage(e)}`, { kind: "error" });
		}
	}, [closeTerm, onClosed]);

	const reconnect = useCallback(async () => {
		const t = term.current;
		if (!termId.current || exited.current || !t) return openNew();
		try {
			await api("POST", `/terminal/${termId.current}/resize`, { cols: t.cols, rows: t.rows });
		} catch (e) {
			if (e instanceof ApiError && isTerminalGone(e.status)) return openNew();
		}
		retries.current = 0;
		attach();
	}, [attach, openNew]);

	// Revocation detaches the browser only; it must not stop the computer's process.
	useEffect(() => {
		const detach = () => {
			if (!isUnauthorized()) return;
			authGeneration.current += 1;
			window.clearTimeout(retryTimer.current);
			source.current?.close();
			source.current = null;
			setStreamState(false);
			queue.current?.clear();
			termId.current = null;
			setPhase("dropped");
			setDetail("配对已失效或被撤销，请重新配对。");
		};
		const unsubscribe = useConnection.subscribe(detach);
		detach();
		return unsubscribe;
	}, []);

	// Mount: lazy-load xterm (separate chunk), wire input, open the PTY.
	useEffect(() => {
		alive.current = true;
		let cleanup = () => {};
		void (async () => {
			const [{ Terminal }, { FitAddon }] = await Promise.all([
				import("@xterm/xterm"),
				import("@xterm/addon-fit"),
				import("@xterm/xterm/css/xterm.css"),
			]);
			const el = host.current;
			if (!alive.current || !el) return;
			const colors = terminalColors();
			const t = new Terminal({
				fontFamily: cssVar("--m-font-mono", "monospace"),
				fontSize: 13,
				cursorBlink: true,
				scrollback: 3000,
				allowProposedApi: false,
				theme: colors,
			});
			const f = new FitAddon();
			t.loadAddon(f);
			t.open(el);
			term.current = t;
			fit.current = f;
			queue.current = new InputQueue(
				(data) => {
					const id = termId.current;
					if (!id || exited.current || !streamOpenRef.current) {
						return Promise.reject(new Error("终端输出流未连接"));
					}
					return api("POST", `/terminal/${id}/input`, { data });
				},
				(e) => toast(`发送失败：${errorMessage(e)}`, { kind: "error" }),
			);
			// Gate input when SSE stream is disconnected so invisible commands are never sent silently.
			const dataSub = t.onData((raw) => {
				if (!streamOpenRef.current || !termId.current || exited.current) {
					toast("输出流未连接，请先重连", { kind: "error" });
					return;
				}
				const { data, consumed } = applyCtrl(raw, ctrlRef.current);
				if (consumed) setCtrl(false);
				queue.current?.push(data);
			});
			const textarea = t.textarea;
			const onFocus = () => setFocused(true);
			const onBlur = () => setFocused(false);
			textarea?.addEventListener("focus", onFocus);
			textarea?.addEventListener("blur", onBlur);

			let frame = 0;
			const ro = new ResizeObserver(() => {
				if (frame) return;
				frame = requestAnimationFrame(() => {
					frame = 0;
					if (!activeRef.current || document.visibilityState === "hidden") return;
					try {
						f.fit();
					} catch {
						/* detached */
					}
					sendResize();
				});
			});
			ro.observe(el);
			const onVisible = () => {
				if (document.visibilityState === "hidden") {
					window.clearTimeout(retryTimer.current);
					return;
				}
				if (activeRef.current && termId.current && !exited.current && !source.current) {
					retries.current = 0;
					attach();
				}
			};
			document.addEventListener("visibilitychange", onVisible);
			const offResync = events.on("resync", () => {
				if (!alive.current || isUnauthorized() || exited.current) return;
				if (!activeRef.current || !termId.current || document.visibilityState === "hidden") return;
				if (!source.current || source.current.readyState === 2) {
					window.clearTimeout(retryTimer.current);
					retries.current = 0;
					attach();
				}
			});
			const schemeObserver = new MutationObserver(() => {
				const c = terminalColors();
				t.options.theme = c;
				setBg(c.background);
			});
			schemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme", "data-theme"] });
			setBg(colors.background);
			cleanup = () => {
				offResync();
				document.removeEventListener("visibilitychange", onVisible);
				schemeObserver.disconnect();
				ro.disconnect();
				textarea?.removeEventListener("focus", onFocus);
				textarea?.removeEventListener("blur", onBlur);
				if (frame) cancelAnimationFrame(frame);
				dataSub.dispose();
				t.dispose();
				term.current = null;
				fit.current = null;
			};
			void open();
		})().catch((e: unknown) => {
			if (!alive.current) return;
			setPhase("error");
			setDetail(errorMessage(e, "终端加载失败"));
		});
		return () => {
			alive.current = false;
			cleanup();
			window.clearTimeout(retryTimer.current);
			source.current?.close();
			source.current = null;
			queue.current?.clear();
			void closeTerm().catch(() => {});
		};
	}, [open, attach, closeTerm, sendResize]);

	useLayer(active && selectMode, () => setSelectMode(false));

	useEffect(() => {
		if (!active) {
			window.clearTimeout(retryTimer.current);
			return;
		}
		if (selectMode) return;
		const frame = requestAnimationFrame(() => {
			const t = term.current;
			if (!t) return;
			try {
				fit.current?.fit();
			} catch {
				/* The host may still be laying out. */
			}
			sendResize();
			t.refresh?.(0, Math.max(0, t.rows - 1));
			if (termId.current && !exited.current && !source.current && document.visibilityState === "visible") attach();
		});
		return () => cancelAnimationFrame(frame);
	}, [active, selectMode, attach, sendResize]);

	const paste = async () => {
		try {
			if (!navigator.clipboard?.readText) throw new Error("浏览器不支持读取剪贴板，请长按终端粘贴");
			const text = await navigator.clipboard.readText();
			if (!termId.current || exited.current || !streamOpenRef.current) throw new Error("终端输出流未连接");
			if (text) term.current?.paste(text);
			term.current?.focus();
		} catch (e) {
			toast(`粘贴失败：${errorMessage(e)}`, { kind: "error" });
		}
	};

	const sendKey = (seq: string) => {
		if (!termId.current || exited.current || !streamOpenRef.current) {
			toast("输出流未连接，请先重连", { kind: "error" });
			return;
		}
		queue.current?.push(seq);
	};

	const openBlockSelect = () => {
		const cleaned = stripAnsi(outputBufferRef.current);
		const parsed = segmentTerminalBlocks(cleaned);
		setBlocks(parsed);
		setSelectedIds(new Set());
		setComment("");
		setSelectMode(true);
	};

	const selectedBlocks = useMemo(() => blocks.filter((b) => selectedIds.has(b.id)), [blocks, selectedIds]);

	const dispatchAnnotation = (target: "main" | "sidechat") => {
		if (selectedBlocks.length === 0) return;
		const combined = selectedBlocks.map((b) => b.text).join("\n\n");
		const payload = {
			quote: fenced(combined, "text"),
			...(comment.trim() ? { comment: comment.trim() } : {}),
			sourceLabel: "终端输出",
		};
		setSelectMode(false);
		setSelectedIds(new Set());
		setComment("");
		if (target === "main") {
			useRightDrawer.getState().sendToMainChat(sessionId, payload);
			if (!embedded) nav.push(paths.chat(sessionId));
		} else {
			if (embedded) {
				useRightDrawer.getState().openSidechatWithAnnotation(sessionId, payload);
			} else {
				const quoted = payload.quote.split("\n").map((l) => `> ${l}`).join("\n");
				const text = payload.comment ? `[来自：终端输出]\n${quoted}\n\n${payload.comment}` : `[来自：终端输出]\n${quoted}\n\n`;
				sessionStorage.setItem(`${SIDECHAT_DRAFT_PREFIX}${sessionId}`, text);
				nav.push(paths.sidechat(sessionId));
			}
		}
	};

	const status = statusDisplay(phase, hasOutput);
	const bad = status.tone === "bad";
	const inputActive = kbOpen || focused;
	const disconnected = !streamOpen && (phase === "dropped" || phase === "reconnecting" || phase === "error" || phase === "exited");

	return (
		<div
			id={`terminal-pane-${tabId}`}
			role="tabpanel"
			aria-labelledby={`terminal-tab-${tabId}`}
			hidden={!active}
			className="relative min-h-0 flex-1 flex-col bg-m-bg"
			style={{ display: active ? "flex" : "none" }}
		>
			{selectMode && (
				<div className="relative z-10 flex min-h-0 flex-1 flex-col bg-m-bg">
					<div className="flex shrink-0 items-center justify-between gap-2 border-b border-m-border px-3 py-2">
						<button
							type="button"
							onClick={() => setSelectMode(false)}
							className="inline-flex min-h-9 items-center gap-1 rounded-m-pill px-2 text-m-xs font-medium whitespace-nowrap text-m-accent active:bg-m-surface"
						>
							<ArrowLeft size={16} />
							返回终端
						</button>
						<span className="text-m-xs font-medium whitespace-nowrap text-m-text-2">已选 {selectedIds.size} 段</span>
						{blocks.length > 0 && (
							<button
								type="button"
								onClick={() =>
									setSelectedIds((prev) =>
										prev.size === blocks.length ? new Set() : new Set(blocks.map((b) => b.id)),
									)
								}
								className="min-h-9 rounded-m-pill px-2.5 text-m-xs font-medium whitespace-nowrap text-m-accent active:bg-m-surface"
							>
								{selectedIds.size === blocks.length ? "取消全选" : "全选"}
							</button>
						)}
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
						{blocks.length === 0 ? (
							<EmptyState
								title="还没有可发送的终端输出"
								hint="在终端运行命令并产生输出后，这里会自动按命令与输出分段"
							/>
						) : (
							<div className="space-y-2.5">
								{blocks.map((b) => {
									const checked = selectedIds.has(b.id);
									return (
										<button
											key={b.id}
											type="button"
											aria-pressed={checked}
											onClick={() =>
												setSelectedIds((prev) => {
													const next = new Set(prev);
													if (next.has(b.id)) next.delete(b.id);
													else next.add(b.id);
													return next;
												})
											}
											className={`block w-full rounded-m-lg border p-3 text-left transition-colors ${
												checked ? "border-m-accent bg-m-accent-soft/25" : "border-m-border bg-m-card"
											}`}
										>
											<div className="mb-1.5 flex items-center justify-between gap-2">
												<span className="min-w-0 truncate font-m-mono text-m-xs font-medium text-m-text-2">
													{b.command ? `$ ${b.command}` : `输出片段（${b.lineCount} 行）`}
												</span>
												<span
													aria-hidden
													className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
														checked ? "border-m-accent bg-m-accent text-m-accent-text" : "border-m-border-strong bg-m-surface"
													}`}
												>
													{checked && <Check size={13} strokeWidth={2.5} />}
												</span>
											</div>
											<pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-all font-m-mono text-m-xs leading-5 text-m-text">
												{b.text}
											</pre>
										</button>
									);
								})}
							</div>
						)}
					</div>
					<div className="shrink-0 space-y-2 border-t border-m-border bg-m-bg px-3 pt-2.5" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 8px)" }}>
						<input
							type="text"
							value={comment}
							onChange={(e) => setComment(e.target.value)}
							aria-label="批注说明"
							placeholder="添加批注说明（可选）..."
							className={`${inputCls} rounded-m-lg py-2 text-[16px]`}
						/>
						<div className="flex gap-2">
							<Button
								variant="tonal"
								className="flex-1"
								icon={<MessageSquarePlus size={16} />}
								disabled={selectedIds.size === 0}
								onClick={() => dispatchAnnotation("main")}
							>
								批注
							</Button>
							<Button
								variant="primary"
								className="flex-1"
								icon={<MessagesSquare size={16} />}
								disabled={selectedIds.size === 0}
								onClick={() => dispatchAnnotation("sidechat")}
							>
								批注到辅助对话
							</Button>
						</div>
					</div>
				</div>
			)}
			<div
				aria-hidden={selectMode || undefined}
				className={selectMode ? "pointer-events-none invisible absolute inset-0 flex flex-col" : "flex min-h-0 flex-1 flex-col"}
			>
			<div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-1.5 pb-1">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					{cwd && (
						<span className="min-w-0 truncate rounded-m-pill bg-m-surface px-2.5 py-0.5 font-m-mono text-m-xs text-m-text-2">
							{abbreviateHomePath(cwd)}
						</span>
					)}
					<div role="status" className={`flex shrink-0 items-center gap-1.5 text-m-xs whitespace-nowrap ${bad ? "text-m-danger" : "text-m-text-3"}`}>
						<span
							aria-hidden
							className={`h-2 w-2 shrink-0 rounded-full ${
								status.tone === "ok" ? "bg-m-success" : bad ? "bg-m-danger" : "m-pulse bg-m-accent"
							}`}
						/>
						<span>{status.label}</span>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					{bad && (
						<IconButton variant="plain" size="sm" icon={<RefreshCw size={17} strokeWidth={1.75} />} label="重连终端" onClick={() => void reconnect()} />
					)}
					<IconButton variant="plain" size="sm" icon={<X size={17} strokeWidth={1.75} />} label={`关闭终端 ${tabId}`} onClick={() => void handleClose()} />
				</div>
			</div>

			{detail && (
				<p role={bad ? "status" : undefined} className={`m-selectable shrink-0 px-3 pb-1 text-m-xs break-words ${bad ? "text-m-danger" : "text-m-text-3"}`}>
					{detail}
				</p>
			)}

			{disconnected && (
				<div role="status" className="mx-3 mb-1.5 flex shrink-0 items-center justify-between gap-2 rounded-m-md bg-m-warn-bg px-3 py-1.5 text-m-xs text-m-warn">
					<span className="min-w-0 flex-1">{phase === "exited" ? "终端进程已退出，输入已暂停" : "输出流已断开，暂不可输入"}</span>
					<Button size="sm" variant="tonal" onClick={() => void reconnect()}>
						{phase === "exited" ? "重启" : "重连"}
					</Button>
				</div>
			)}

			<div className="min-h-0 flex-1 px-3 pb-1.5">
				<div
					onClick={() => {
						term.current?.focus();
						setFocused(true);
					}}
					className="relative h-full overflow-hidden rounded-m-lg border border-m-border p-2.5"
					style={bg ? { background: bg } : undefined}
				>
					<div ref={host} className="h-full w-full overflow-hidden" />
					{!hasOutput && (phase === "connecting" || phase === "connected") && (
						<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
							<span className="m-shimmer rounded-m-pill bg-m-bg-elev/90 px-3.5 py-1.5 text-m-xs text-m-text-2 shadow-m-card">
								{phase === "connecting" ? "正在启动终端…" : "等待终端响应…"}
							</span>
						</div>
					)}
					{hasOutput && streamOpen && !focused && (
						<div className="pointer-events-none absolute right-2.5 bottom-2.5">
							<span className="rounded-m-pill bg-m-bg-elev/90 px-2.5 py-1 text-m-xs text-m-text-3 shadow-m-card">
								轻点终端区域开始输入
							</span>
						</div>
					)}
				</div>
			</div>

			<div className="shrink-0 border-t border-m-border bg-m-bg px-3 pt-1.5" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 6px)" }}>
				{!inputActive ? (
					<div className="m-noscrollbar flex items-center gap-1.5 overflow-x-auto pb-0.5">
						<KeyButton
							onPress={() => {
								term.current?.focus();
								setFocused(true);
							}}
						>
							<Keyboard size={14} className="mr-1" />
							键盘/输入
						</KeyButton>
						<KeyButton onPress={openBlockSelect}>
							<Sparkles size={14} className="mr-1" />
							发给 AI
						</KeyButton>
						<KeyButton onPress={() => term.current?.clear()}>
							<Eraser size={14} className="mr-1" />
							清屏
						</KeyButton>
						<KeyButton onPress={() => void reconnect()}>
							<RefreshCw size={14} className="mr-1" />
							重连
						</KeyButton>
					</div>
				) : (
					<div className="m-noscrollbar flex items-center gap-1.5 overflow-x-auto pb-0.5">
						{COMPACT_SPECIAL_KEYS.map((key) => (
							<span key={key.id} className="flex shrink-0 items-center gap-1.5">
								<KeyButton onPress={() => sendKey(key.seq)}>{key.label}</KeyButton>
								{key.id === "esc" && (
									<KeyButton active={ctrl} onPress={() => setCtrl(!ctrlRef.current)}>
										Ctrl
									</KeyButton>
								)}
							</span>
						))}
						<KeyButton onPress={() => void paste()}>粘贴</KeyButton>
						<KeyButton onPress={openBlockSelect}>发给 AI</KeyButton>
						<KeyButton
							onPress={() => {
								term.current?.blur();
								setFocused(false);
							}}
						>
							收起
						</KeyButton>
					</div>
				)}
			</div>
			</div>
		</div>
	);
}

function KeyButton({
	children,
	onPress,
	active = false,
}: {
	children: ReactNode;
	onPress: () => void;
	active?: boolean;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			// Keep the soft keyboard up: do not steal focus from xterm's textarea.
			onPointerDown={(e) => e.preventDefault()}
			onClick={onPress}
			className="flex min-h-10 shrink-0 items-center"
		>
			<span
				className={`flex h-8 items-center justify-center rounded-m-pill px-3 text-m-xs font-medium whitespace-nowrap ${
					active ? "bg-m-accent text-m-accent-text" : "bg-m-surface text-m-text active:bg-m-surface-2"
				}`}
			>
				{children}
			</span>
		</button>
	);
}
