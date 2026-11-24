import {
	ArrowDown,
	Camera,
	ChevronRight,
	Copy,
	CornerDownLeft,
	FileText,
	ImagePlus,
	MessagesSquare,
	MoreHorizontal,
	Paperclip,
	Pencil,
	RefreshCw,
	Sparkles,
	Trash2,
	X,
} from "lucide-react";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isSideChatPrompt, trimSideChatItems } from "../../../src/features/chat/sideChatView";
import { api, errorMessage, upload } from "../../core/api";
import { copyText, relTime, sessionName } from "../../core/lib/format";
import { imageFromBlob } from "../../core/lib/images";
import { nav, paths, type PageProps } from "../../core/nav";
import { transcriptImages } from "../../core/normalize";
import { events } from "../../core/sse";
import { usePref } from "../../core/stores/prefs";
import { useSessions } from "../../core/stores/sessions";
import { STATUS_LABEL, isDraftId, type ImageRef, type Item, type MobileSession, type TranscriptPage } from "../../core/types";
import {
	AnchoredPopover,
	BottomSheet,
	Button,
	EmptyState,
	IconButton,
	MenuRow,
	PageHeader,
	PullToRefresh,
	TextField,
	TitleSwitcher,
	confirm,
	inputCls,
	toast,
	type TitleSwitcherItem,
} from "../../ui";
import { ActionTile } from "../../ui/ActionTile";
import { Markdown } from "../../ui/Markdown";
import { ChatCtx } from "../chat/ChatContext";
import type { Attachment, ComposerState } from "../chat/chatStore";
import { ComposerCapsule, type ComposerApi } from "../chat/components/ComposerCapsule";
import { ContextSheet } from "../chat/components/ContextSheet";
import { ModelThinkingSheet } from "../chat/components/ModelThinkingSheet";
import { ThinkingSourcePopover } from "../chat/components/ThinkingLevelPopover";
import { Thinking } from "../chat/components/Thinking";
import { ToolCard, toolState } from "../chat/components/ToolCard";
import { Images } from "../chat/components/TurnView";
import { sessionModelSource, type ModelSource } from "../chat/components/useModelFacts";
import { contextTone, formatContextPercent, resolveContextPercent } from "../chat/lib/context";
import { parseModelRef, resolveThinkingLevels, type ModelOpt } from "../chat/lib/models";
import { BEHAVIOR_HINT, BEHAVIOR_LABEL, attachmentBlocker, buildPrompt, type StreamBehavior } from "../chat/lib/prompt";
import { formatDesktopStatParts, formatStatClock, requestStatFromItem, type RequestStat } from "../chat/lib/requestStats";
import { EMPTY_TRANSCRIPT, mergePage } from "../chat/lib/transcript";
import { loadUnsent, saveUnsent } from "../chat/lib/unsent";
import { ErrorState, LoadGate, Loading } from "./PanelState";
import { useLoad, useResync, type LoadState } from "./hooks";
import { useRightDrawer, type SidechatAnnotationPayload } from "./rightDrawerStore";

type PendingMessage = { id: number; text: string; images: ImageRef[] };
type SidechatImage = { mime: string; data: string };
type SidechatMessage = { text: string; imagePaths: string[]; images: SidechatImage[] };
type SidechatAttachment = Attachment & { file: File; image?: SidechatImage };
type DraftInject = { targetKey: string; text: string; nonce: number };

const NEW_DRAFT_KEY = "__new__";
const EMPTY_ATTS: SidechatAttachment[] = [];
const EMPTY_ROWS: MobileSession[] = [];
export const HANDBACK_MARKER = "【回传整理】";
export const HANDBACK_PROMPT = `${HANDBACK_MARKER}请把我们在这个辅助对话里讨论并确定下来的内容，整理成一份可以交给主会话的结论。

要求：
1. 提取所有已达成的共识、最终方案与关键决定；
2. 保持简短精炼，分点说明，方便主会话快速了解上下文；
3. 直接输出结论内容，不要添加额外的寒暄或多余包装。`;

/** sessionStorage key prefix (+ parent session id) of a quote handed over by a thread annotation. */
export const SIDECHAT_DRAFT_PREFIX = "omp:sidechat-draft:";

const q = encodeURIComponent;
const FETCH_INTERVAL_MS = 400;
const MAX_ROWS = 80;
const LONG_TIMEOUT_MS = 600_000;
const ICON = { size: 22, strokeWidth: 1.75 } as const;
const TONE_TEXT = { neutral: "text-m-text-3", warn: "text-m-warn", danger: "text-m-danger" } as const;

function formatAnnotationPayload(payload: SidechatAnnotationPayload): string {
	const quoted = payload.quote
		.trim()
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
	const header = payload.sourceLabel ? `[来自：${payload.sourceLabel}]\n` : "";
	const comment = payload.comment?.trim();
	return comment ? `${header}${quoted}\n\n${comment}` : `${header}${quoted}\n\n`;
}

/** Text of the first assistant reply after the latest handback request, if any. */
function handbackReply(items: readonly Item[]): string | null {
	for (let i = items.length - 1; i >= 0; i--) {
		const it = items[i];
		if (it.role === "user" && it.text?.includes(HANDBACK_MARKER)) {
			return items.slice(i + 1).find((x) => x.role === "assistant" && x.text)?.text ?? null;
		}
	}
	return null;
}

/** Text + streaming flag of the `index`-th (0-based) handback request reply, if present. */
function nthHandbackReply(items: readonly Item[], index: number): { text: string; streaming: boolean } | null {
	let seen = 0;
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		if (it.role === "user" && it.text?.includes(HANDBACK_MARKER)) {
			if (seen === index) {
				const reply = items.slice(i + 1).find((x) => x.role === "assistant" && x.text);
				return reply?.text ? { text: reply.text, streaming: Boolean(reply.streaming) } : null;
			}
			seen++;
		}
	}
	return null;
}

interface SidechatDraftController {
	getText: (key: string) => string;
	setText: (key: string, text: string) => void;
	appendText: (key: string, text: string) => void;
	getAtts: (key: string) => SidechatAttachment[];
	addFiles: (key: string, files: readonly File[]) => void;
	retryAtt: (key: string, att: SidechatAttachment) => void;
	removeAtt: (key: string, att: SidechatAttachment) => void;
	consumeSent: (key: string, sentText: string, sentAtts: readonly SidechatAttachment[]) => void;
	transfer: (fromKey: string, toKey: string) => void;
	discardKey: (key: string) => void;
	markInjectConsumed: (nonce: number) => boolean;
}

function useSidechatDrafts(parentSessionId: string): SidechatDraftController {
	const alive = useRef(true);
	const textsRef = useRef<Record<string, string>>({});
	const consumedNonces = useRef(new Set<number>());
	const [attsByKey, setAttsByKey] = useState<Record<string, SidechatAttachment[]>>({});
	const attsRef = useRef(attsByKey);
	attsRef.current = attsByKey;
	const nextAttId = useRef(0);
	const uploads = useRef(new Map<string, AbortController>());

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			for (const ctl of uploads.current.values()) ctl.abort();
			uploads.current.clear();
			for (const list of Object.values(attsRef.current)) {
				for (const att of list) if (att.url) URL.revokeObjectURL(att.url);
			}
		};
	}, [parentSessionId]);

	const patchAtt = useCallback((key: string, id: number, patch: Partial<SidechatAttachment>) => {
		if (!alive.current) return;
		setAttsByKey((prev) => {
			const cur = prev[key];
			if (!cur) return prev;
			return { ...prev, [key]: cur.map((att) => (att.id === id ? { ...att, ...patch } : att)) };
		});
	}, []);

	const uploadAtt = useCallback(
		async (key: string, att: SidechatAttachment) => {
			const uploadKey = `${key}:${att.id}`;
			uploads.current.get(uploadKey)?.abort();
			const ctl = new AbortController();
			uploads.current.set(uploadKey, ctl);
			patchAtt(key, att.id, { status: "up", err: undefined });
			try {
				let image: SidechatImage | undefined;
				if (att.isImage) image = await imageFromBlob(att.file);
				if (ctl.signal.aborted) return;
				const result = await upload<{ path: string }>(`/sessions/${q(parentSessionId)}/upload`, att.file, {
					name: att.name,
					signal: ctl.signal,
				});
				patchAtt(key, att.id, { status: "ok", path: result.path, image });
			} catch (e) {
				if (!ctl.signal.aborted) {
					patchAtt(key, att.id, { status: "err", err: errorMessage(e) });
					toast(`上传失败：${errorMessage(e)}`, { kind: "error" });
				}
			} finally {
				if (uploads.current.get(uploadKey) === ctl) uploads.current.delete(uploadKey);
			}
		},
		[parentSessionId, patchAtt],
	);

	const addFiles = useCallback(
		(key: string, files: readonly File[]) => {
			const created: SidechatAttachment[] = [];
			for (const file of files) {
				if (file.size > 20 * 1024 * 1024) {
					toast(`「${file.name}」超过 20MB 上限，无法上传`, { kind: "error" });
					continue;
				}
				const isImage = file.type.startsWith("image/");
				created.push({
					id: ++nextAttId.current,
					name: file.name || "附件",
					isImage,
					url: isImage ? URL.createObjectURL(file) : "",
					status: "up",
					file,
				});
			}
			if (!created.length) return;
			setAttsByKey((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), ...created] }));
			for (const att of created) void uploadAtt(key, att);
		},
		[uploadAtt],
	);

	const removeAtt = useCallback((key: string, att: SidechatAttachment) => {
		const uploadKey = `${key}:${att.id}`;
		uploads.current.get(uploadKey)?.abort();
		uploads.current.delete(uploadKey);
		if (att.url) URL.revokeObjectURL(att.url);
		setAttsByKey((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((item) => item.id !== att.id) }));
	}, []);

	const consumeSent = useCallback((key: string, sentText: string, sentAtts: readonly SidechatAttachment[]) => {
		if ((textsRef.current[key] ?? "") === sentText) {
			textsRef.current[key] = "";
		}
		if (sentAtts.length > 0) {
			const sentIds = new Set(sentAtts.map((a) => a.id));
			for (const att of sentAtts) if (att.url) URL.revokeObjectURL(att.url);
			setAttsByKey((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((att) => !sentIds.has(att.id)) }));
		}
	}, []);

	const transfer = useCallback((fromKey: string, toKey: string) => {
		if (fromKey === toKey) return;
		const fromText = textsRef.current[fromKey];
		if (fromText) {
			const toText = textsRef.current[toKey] ?? "";
			textsRef.current[toKey] = toText.trim() ? `${toText.replace(/\s+$/, "")}\n\n${fromText}` : fromText;
			delete textsRef.current[fromKey];
		}
		const fromAtts = attsRef.current[fromKey];
		if (fromAtts?.length) {
			setAttsByKey((prev) => {
				const moved = prev[fromKey];
				if (!moved?.length) return prev;
				const next = { ...prev };
				delete next[fromKey];
				next[toKey] = [...(next[toKey] ?? []), ...moved];
				return next;
			});
		}
	}, []);

	const discardKey = useCallback((key: string) => {
		delete textsRef.current[key];
		const prefix = `${key}:`;
		for (const [uk, ctl] of uploads.current.entries()) {
			if (uk.startsWith(prefix)) {
				ctl.abort();
				uploads.current.delete(uk);
			}
		}
		const list = attsRef.current[key];
		if (list?.length) {
			for (const att of list) if (att.url) URL.revokeObjectURL(att.url);
			setAttsByKey((prev) => {
				const next = { ...prev };
				delete next[key];
				return next;
			});
		}
	}, []);

	return useMemo(
		() => ({
			getText: (key: string) => textsRef.current[key] ?? "",
			setText: (key: string, text: string) => {
				textsRef.current[key] = text;
			},
			appendText: (key: string, text: string) => {
				const cur = textsRef.current[key] ?? "";
				textsRef.current[key] = cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n${text}` : text;
			},
			getAtts: (key: string) => attsRef.current[key] ?? EMPTY_ATTS,
			addFiles,
			retryAtt: (key: string, att: SidechatAttachment) => void uploadAtt(key, att),
			removeAtt,
			consumeSent,
			transfer,
			discardKey,
			markInjectConsumed: (nonce: number) => {
				if (consumedNonces.current.has(nonce)) return false;
				consumedNonces.current.add(nonce);
				return true;
			},
		}),
		[addFiles, uploadAtt, removeAtt, consumeSent, transfer, discardKey],
	);
}

export function SidechatPanel({
	sessionId,
	embedded = false,
	active = true,
}: {
	sessionId: string;
	embedded?: boolean;
	active?: boolean;
}) {
	return <SidechatPanelInner key={sessionId} sessionId={sessionId} embedded={embedded} active={active} />;
}

function SidechatPanelInner({
	sessionId,
	embedded = false,
	active = true,
}: {
	sessionId: string;
	embedded?: boolean;
	active?: boolean;
}) {
	const draftSession = isDraftId(sessionId);
	const alive = useRef(true);
	const parentRef = useRef(sessionId);
	parentRef.current = sessionId;
	const drafts = useSidechatDrafts(sessionId);
	const [mode, setMode] = useState<"thread" | "new">("new");
	const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
	const viewRef = useRef<{ mode: "thread" | "new"; activeThreadId: string | null }>({ mode: "new", activeThreadId: null });
	viewRef.current = { mode, activeThreadId };
	const [createdMetaMap, setCreatedMetaMap] = useState<Record<string, SidechatMessage>>({});
	const justCreatedIds = useRef(new Set<string>());
	const [handbackOpen, setHandbackOpen] = useState(false);
	const [canHandback, setCanHandback] = useState(false);
	const [draftInject, setDraftInject] = useState<DraftInject | null>(null);
	const injectSeq = useRef(0);
	const autoInitializedFor = useRef<string | null>(null);

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	// Reset selection cleanly when switching parent sessions.
	useEffect(() => {
		setMode("new");
		setActiveThreadId(null);
		setCreatedMetaMap({});
		justCreatedIds.current.clear();
		setHandbackOpen(false);
		setCanHandback(false);
		autoInitializedFor.current = null;

		const draftKey = `${SIDECHAT_DRAFT_PREFIX}${sessionId}`;
		const stored = sessionStorage.getItem(draftKey);
		sessionStorage.removeItem(draftKey);
		if (stored) {
			if (viewRef.current.mode === "new") {
				setDraftInject({ targetKey: NEW_DRAFT_KEY, text: stored, nonce: ++injectSeq.current });
			} else {
				drafts.appendText(NEW_DRAFT_KEY, stored);
				setDraftInject(null);
			}
		} else {
			setDraftInject(null);
		}
	}, [sessionId, drafts]);

	const state = useLoad(
		async (signal) => {
			if (draftSession) return [] as MobileSession[];
			const raw = await api<MobileSession[] | { sidechats?: MobileSession[] }>(
				"GET",
				`/sessions/${q(sessionId)}/sidechats`,
				undefined,
				{ signal },
			);
			const list = Array.isArray(raw) ? raw : Array.isArray(raw?.sidechats) ? raw.sidechats : [];
			return list.filter((r) => !r.archived).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
		},
		[sessionId, draftSession],
	);
	useResync(() => void state.reload(true));

	const rows = state.data ?? EMPTY_ROWS;
	const pendingSidechat = useRightDrawer((s) => s.pendingSidechat);

	// Initial auto-select and ongoing reconciliation whenever a refreshed list succeeds.
	useEffect(() => {
		if (state.loading || state.data === null || state.error !== null) return;
		if (autoInitializedFor.current !== sessionId) {
			autoInitializedFor.current = sessionId;
			if (rows.length > 0 && !activeThreadId) {
				setActiveThreadId(rows[0].id);
				setMode("thread");
			} else if (rows.length === 0 && viewRef.current.mode !== "thread") {
				setMode("new");
			}
			return;
		}
		if (mode === "thread" && activeThreadId) {
			const exists = rows.some((r) => r.id === activeThreadId);
			if (exists) {
				justCreatedIds.current.delete(activeThreadId);
			} else if (!justCreatedIds.current.has(activeThreadId)) {
				if (rows.length > 0) {
					setActiveThreadId(rows[0].id);
				} else {
					setActiveThreadId(null);
					setMode("new");
					setCanHandback(false);
				}
			}
		}
	}, [sessionId, state.loading, state.data, state.error, rows, mode, activeThreadId]);

	const createSidechat = useCallback(
		async (
			message: SidechatMessage,
			sentText = "",
			sentAtts: readonly SidechatAttachment[] = [],
			opts?: { model?: string | null; thinkingLevel?: string | null },
		): Promise<boolean> => {
			const targetParent = sessionId;
			try {
				const info = await api<{ sessionId: string }>("POST", `/sessions/${q(targetParent)}/sidechats`, {
					question: message.text,
					imagePaths: message.imagePaths,
					...(opts?.model ? { model: opts.model } : {}),
				});
				if (opts?.thinkingLevel) {
					void api("POST", `/sessions/${q(info.sessionId)}/thinking`, { level: opts.thinkingLevel }).catch(() => {});
				}
				void useSessions.getState().refresh();
				if (!alive.current || parentRef.current !== targetParent) return true;
				drafts.consumeSent(NEW_DRAFT_KEY, sentText, sentAtts);
				justCreatedIds.current.add(info.sessionId);
				setCreatedMetaMap((prev) => ({ ...prev, [info.sessionId]: message }));
				if (viewRef.current.mode === "new") {
					drafts.transfer(NEW_DRAFT_KEY, info.sessionId);
					setActiveThreadId(info.sessionId);
					setMode("thread");
				} else {
					toast("新辅助对话已创建", { kind: "success" });
				}
				void state.reload(true);
				return true;
			} catch (e) {
				if (!alive.current || parentRef.current !== targetParent) return false;
				toast(`发起失败：${errorMessage(e)}`, { kind: "error" });
				return false;
			}
		},
		[sessionId, drafts, state.reload],
	);

	// Consume structured annotations targeted at Sidechat (from MessageActions or Terminal block multi-select).
	useEffect(() => {
		if (!pendingSidechat || pendingSidechat.sessionId !== sessionId || draftSession) return;
		if (state.loading && state.data === null) return;
		const payload = useRightDrawer.getState().consumeSidechatAnnotation(sessionId);
		if (!payload) return;
		const text = formatAnnotationPayload(payload);
		if (rows.length === 0 && payload.comment?.trim()) {
			// First sidechat with explicit comment: create and open immediately so the user sees the answer stream.
			const msg: SidechatMessage = { text, imagePaths: [], images: [] };
			void createSidechat(msg);
			return;
		}
		let targetKey = NEW_DRAFT_KEY;
		if (rows.length > 0) {
			targetKey = activeThreadId ?? rows[0].id;
			setActiveThreadId(targetKey);
			setMode("thread");
		} else {
			setMode("new");
		}
		const currentKey = viewRef.current.mode === "thread" && viewRef.current.activeThreadId ? viewRef.current.activeThreadId : NEW_DRAFT_KEY;
		if (currentKey === targetKey) {
			setDraftInject({ targetKey, text, nonce: ++injectSeq.current });
		} else {
			drafts.appendText(targetKey, text);
		}
	}, [pendingSidechat, sessionId, draftSession, state.loading, state.data, rows, activeThreadId, createSidechat, drafts]);

	const sessionsById = useSessions((s) => s.byId);
	const activeRow = useMemo(
		() => rows.find((r) => r.id === activeThreadId) ?? (activeThreadId ? sessionsById[activeThreadId] : undefined),
		[rows, activeThreadId, sessionsById],
	);
	const headerTitle = draftSession
		? "辅助对话"
		: mode === "thread" && activeRow
			? sessionName(activeRow)
			: mode === "thread" && activeThreadId
				? "辅助对话"
				: state.loading && state.data === null
					? "辅助对话"
					: "新辅助对话";
	const hasHandback = !draftSession && mode === "thread" && !!activeThreadId && canHandback;

	const [moreOpen, setMoreOpen] = useState(false);
	const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
	useEffect(() => {
		if (!active || (mode !== "thread" && !hasHandback)) setMoreOpen(false);
	}, [active, mode, hasHandback]);

	const openHandback = useCallback(() => setHandbackOpen(true), []);
	const [renameTarget, setRenameTarget] = useState<MobileSession | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [renaming, setRenaming] = useState(false);

	const openRename = useCallback((target: MobileSession) => {
		setRenameTarget(target);
		setRenameDraft(target.customName?.trim() || "");
	}, []);

	const saveRename = async () => {
		if (!renameTarget || renaming) return;
		setRenaming(true);
		try {
			await api("PATCH", `/left/sessions/${q(renameTarget.id)}`, { customName: renameDraft.trim() });
			toast("已重命名", { kind: "success" });
			setRenameTarget(null);
			void useSessions.getState().refresh();
			await state.reload(true);
		} catch (e) {
			toast(`重命名失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setRenaming(false);
		}
	};

	const deleteThread = useCallback(
		async (target: MobileSession) => {
			const busy = target.status === "working" || target.status === "awaiting_answer" || target.status === "awaiting_approval";
			const ok = await confirm({
				title: "删除辅助对话",
				message: busy
					? `「${sessionName(target)}」正在运行中，确定删除并移除吗？`
					: `确定删除「${sessionName(target)}」？删除后将从辅助对话列表移除。`,
				confirmText: "删除",
				danger: true,
			});
			if (!ok) return;
			try {
				await api("PATCH", `/left/sessions/${q(target.id)}`, { archived: true });
				justCreatedIds.current.delete(target.id);
				drafts.discardKey(target.id);
				setCreatedMetaMap((prev) => {
					if (!(target.id in prev)) return prev;
					const next = { ...prev };
					delete next[target.id];
					return next;
				});
				toast("已删除辅助对话", { kind: "success" });
				void useSessions.getState().refresh();
				await state.reload(true);
			} catch (e) {
				toast(`删除失败：${errorMessage(e)}`, { kind: "error" });
			}
		},
		[drafts, state.reload],
	);

	const moreActions = useMemo(() => {
		const list: Array<{ id: string; label: string; icon: ReactNode; danger?: boolean; onSelect: () => void }> = [];
		if (hasHandback) {
			list.push({
				id: "handback",
				label: "把结论发回主对话",
				icon: <CornerDownLeft size={18} strokeWidth={1.75} />,
				onSelect: openHandback,
			});
		}
		if (mode === "thread" && activeRow) {
			const target = activeRow;
			list.push({
				id: "rename",
				label: "重命名此辅助对话",
				icon: <Pencil size={18} strokeWidth={1.75} />,
				onSelect: () => openRename(target),
			});
			list.push({
				id: "delete",
				label: "删除此辅助对话",
				icon: <Trash2 size={18} strokeWidth={1.75} />,
				danger: true,
				onSelect: () => void deleteThread(target),
			});
		}
		return list;
	}, [hasHandback, openHandback, mode, activeRow, openRename, deleteThread]);

	const switcherItems = useMemo<TitleSwitcherItem[]>(() => {
		const items: TitleSwitcherItem[] = rows.map((s) => ({
			id: s.id,
			label: sessionName(s),
			subtitle: `${STATUS_LABEL[s.status] ?? s.status} · ${relTime(s.updatedAt)}`,
			badge: s.status === "working" ? "var(--m-accent)" : undefined,
			removable: true,
		}));
		if (mode === "new" || rows.length === 0) {
			items.unshift({
				id: NEW_DRAFT_KEY,
				label: "新辅助对话",
				subtitle: "基于当前主对话创建新分支",
			});
		}
		return items;
	}, [rows, mode]);

	const selectFromSwitcher = useCallback((id: string) => {
		if (id === NEW_DRAFT_KEY) {
			setMode("new");
			setActiveThreadId(null);
			setCanHandback(false);
			return;
		}
		setActiveThreadId(id);
		setMode("thread");
	}, []);

	const stepFromSwitcher = useCallback(
		(dir: -1 | 1) => {
			if (rows.length === 0) return;
			if (mode !== "thread" || !activeThreadId) {
				const target = dir > 0 ? rows[0] : rows[rows.length - 1];
				if (target) {
					setActiveThreadId(target.id);
					setMode("thread");
				}
				return;
			}
			if (rows.length < 2) return;
			const idx = rows.findIndex((r) => r.id === activeThreadId);
			const next = rows[(idx + dir + rows.length) % rows.length];
			if (next) setActiveThreadId(next.id);
		},
		[rows, mode, activeThreadId],
	);

	const removeFromSwitcher = useCallback(
		(id: string) => {
			const target = rows.find((r) => r.id === id);
			if (target) void deleteThread(target);
		},
		[rows, deleteThread],
	);

	const startNewThread = useCallback(() => {
		setMode("new");
		setActiveThreadId(null);
		setCanHandback(false);
	}, []);

	const titleSwitcherConfig = useMemo(
		() =>
			draftSession
				? undefined
				: {
						label: headerTitle,
						ariaLabel: "切换辅助对话",
						popoverTitle: `全部辅助对话（${rows.length}）`,
						emptyText: "还没有辅助对话，点击下方新建或在对话框提问",
						items: switcherItems,
						activeId: mode === "thread" && activeThreadId ? activeThreadId : NEW_DRAFT_KEY,
						onSelect: selectFromSwitcher,
						onStep: rows.length > 0 ? stepFromSwitcher : undefined,
						onRemove: removeFromSwitcher,
						create: { label: "新建辅助对话", onClick: startNewThread },
					},
		[
			draftSession,
			headerTitle,
			rows.length,
			switcherItems,
			mode,
			activeThreadId,
			selectFromSwitcher,
			stepFromSwitcher,
			removeFromSwitcher,
			startNewThread,
		],
	);

	useEffect(() => {
		if (!embedded) return;
		useRightDrawer.getState().setTabHeader(sessionId, "sidechat", {
			title: headerTitle,
			moreActions,
			titleSwitcher: titleSwitcherConfig,
		});
	}, [embedded, sessionId, headerTitle, moreActions, titleSwitcherConfig]);
	useEffect(() => {
		if (!embedded) return;
		return () => {
			useRightDrawer.getState().clearTabHeader(sessionId, "sidechat");
		};
	}, [embedded, sessionId]);

	if (draftSession) {
		const empty = <EmptyState icon={<MessagesSquare {...ICON} />} title="发送首条消息后可用" hint="辅助对话会基于当前主对话上下文分支展开" />;
		return embedded ? (
			<div className="flex h-full min-h-0 flex-1 flex-col bg-m-bg">{empty}</div>
		) : (
			<div className="flex h-full flex-col bg-m-bg">
				<PageHeader title="辅助对话" onBack={() => nav.back()} />
				{empty}
			</div>
		);
	}

	const body = (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
			{mode === "thread" && activeThreadId ? (
				<ThreadView
					key={`${sessionId}:${activeThreadId}`}
					parentId={sessionId}
					threadId={activeThreadId}
					embedded={embedded}
					active={active}
					drafts={drafts}
					initial={createdMetaMap[activeThreadId]}
					draftInject={draftInject?.targetKey === activeThreadId ? draftInject : null}
					handbackOpen={handbackOpen}
					onCloseHandback={() => setHandbackOpen(false)}
					onCanHandbackChange={setCanHandback}
				/>
			) : (
				<NewSidechatView
					key={sessionId}
					sessionId={sessionId}
					active={active}
					drafts={drafts}
					state={state}
					draftInject={draftInject?.targetKey === NEW_DRAFT_KEY ? draftInject : null}
					onCreate={createSidechat}
				/>
			)}

			<BottomSheet
				open={active && renameTarget !== null}
				onClose={() => {
					if (!renaming) setRenameTarget(null);
				}}
				title="重命名辅助对话"
				footer={
					<div className="flex gap-2 px-4 pt-2 pb-3">
						<Button variant="tonal" className="flex-1" disabled={renaming} onClick={() => setRenameTarget(null)}>
							取消
						</Button>
						<Button variant="primary" className="flex-1" busy={renaming} onClick={() => void saveRename()}>
							保存
						</Button>
					</div>
				}
			>
				<div className="px-4 py-2">
					<TextField
						aria-label="会话名称"
						value={renameDraft}
						onChange={(e) => setRenameDraft(e.target.value)}
						placeholder={renameTarget ? sessionName(renameTarget) : "输入名称（留空则恢复默认）"}
						autoFocus
					/>
				</div>
			</BottomSheet>
		</div>
	);

	if (embedded) return <div className="flex h-full min-h-0 flex-1 flex-col bg-m-bg">{body}</div>;

	return (
		<div className="flex h-full flex-col bg-m-bg">
			<PageHeader
				title={
					titleSwitcherConfig ? (
						<TitleSwitcher
							label={titleSwitcherConfig.label}
							ariaLabel={titleSwitcherConfig.ariaLabel}
							popoverTitle={titleSwitcherConfig.popoverTitle}
							emptyText={titleSwitcherConfig.emptyText}
							items={titleSwitcherConfig.items}
							activeId={titleSwitcherConfig.activeId}
							onSelect={titleSwitcherConfig.onSelect}
							onStep={titleSwitcherConfig.onStep}
							onRemove={titleSwitcherConfig.onRemove}
							create={titleSwitcherConfig.create}
						/>
					) : (
						headerTitle
					)
				}
				onBack={() => nav.back()}
				right={
					moreActions.length > 0 ? (
						<button
							type="button"
							aria-label="更多操作"
							aria-haspopup="menu"
							aria-expanded={moreOpen}
							onClick={(e) => {
								setMoreAnchor(e.currentTarget);
								setMoreOpen((v) => !v);
							}}
							className="m-press inline-flex h-10 w-10 items-center justify-center rounded-m-pill text-m-text-2 active:bg-m-surface-hover active:text-m-text"
						>
							<MoreHorizontal size={20} strokeWidth={1.85} />
						</button>
					) : undefined
				}
			/>
			{body}
			<AnchoredPopover
				open={active && moreOpen && moreActions.length > 0}
				onClose={() => setMoreOpen(false)}
				anchorEl={moreAnchor}
				placement="bottom-end"
				minWidth={196}
				maxWidth={260}
				className="m-liquid-surface rounded-2xl!"
			>
				<div className="py-1">
					{moreActions.map((a) => (
						<MenuRow
							key={a.id}
							icon={a.icon}
							label={a.label}
							danger={a.danger}
							onClick={() => {
								setMoreOpen(false);
								a.onSelect();
							}}
						/>
					))}
				</div>
			</AnchoredPopover>
		</div>
	);
}

export function SidechatPage({ route }: PageProps) {
	return <SidechatPanel sessionId={route.params.id} />;
}

/* ---------------------------------------------------------------- new */

function NewSidechatView({
	sessionId,
	active,
	drafts,
	state,
	draftInject,
	onCreate,
}: {
	sessionId: string;
	active: boolean;
	drafts: SidechatDraftController;
	state: LoadState<MobileSession[]>;
	draftInject: DraftInject | null;
	onCreate: (
		message: SidechatMessage,
		sentText: string,
		sentAtts: readonly SidechatAttachment[],
		opts?: { model?: string | null; thinkingLevel?: string | null },
	) => Promise<boolean>;
}) {
	const chatCtx = useContext(ChatCtx);
	const controller = chatCtx?.controller.id === sessionId ? chatCtx.controller : null;
	const [parentCstate, setParentCstate] = useState(() => controller?.state.cstate ?? null);
	useEffect(() => {
		if (!controller) {
			setParentCstate(null);
			return;
		}
		setParentCstate(controller.state.cstate ?? null);
		return controller.store.subscribe((s) => {
			setParentCstate(s.cstate ?? null);
		});
	}, [controller]);
	const parentCstateRef = useRef(parentCstate);
	parentCstateRef.current = parentCstate;
	const [draftModel, setDraftModel] = useState<string | null>(null);
	const [draftThinking, setDraftThinking] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const [thinkingAnchor, setThinkingAnchor] = useState<HTMLElement | null>(null);
	const draftModelRef = useRef(draftModel);
	const draftThinkingRef = useRef(draftThinking);
	draftModelRef.current = draftModel;
	draftThinkingRef.current = draftThinking;
	const cachedModelsRef = useRef<ModelOpt[]>([]);

	const draftModelSource = useMemo<ModelSource>(() => {
		const base = sessionModelSource(sessionId);
		return {
			load: async () => {
				// Load catalog from non-blocking /left/roles first so Sidechat model picker stays responsive
				// even when the parent session is actively streaming a turn.
				let models: ModelOpt[] = [];
				let fallbackCurrent: { provider?: string; id: string } | null = null;
				let fallbackThinking: string | null = null;
				let fallbackLive: string[] = [];
				try {
					const roles = await api<{ models?: ModelOpt[] }>("GET", "/left/roles");
					models = roles.models ?? [];
				} catch {
					// Fallback to session-scoped endpoint when /left/roles is unavailable.
				}
				if (models.length === 0) {
					const res = await base.load();
					models = res.models;
					fallbackCurrent = res.current;
					fallbackThinking = res.thinkingLevel;
					fallbackLive = res.liveThinking;
				}
				cachedModelsRef.current = models;
				const parent = parentCstateRef.current;
				const picked = parseModelRef(draftModelRef.current ?? parent?.model ?? null);
				const current = picked ? { provider: picked.provider, id: picked.id } : fallbackCurrent;
				const curOpt = current
					? (models.find((m) => m.id === current.id && (!current.provider || m.provider === current.provider)) ?? null)
					: null;
				const thinkingLevel = draftThinkingRef.current ?? parent?.thinkingLevel ?? fallbackThinking;
				return {
					models,
					current,
					thinkingLevel,
					liveThinking: curOpt ? resolveThinkingLevels(curOpt, fallbackLive, thinkingLevel) : fallbackLive,
				};
			},
			setModel: async (m) => {
				const ref = `${m.provider}/${m.id}`;
				draftModelRef.current = ref;
				setDraftModel(ref);
				const levels = resolveThinkingLevels(m, null, draftThinkingRef.current);
				const nextLevel =
					draftThinkingRef.current && levels.includes(draftThinkingRef.current)
						? draftThinkingRef.current
						: (levels[0] ?? null);
				draftThinkingRef.current = nextLevel;
				setDraftThinking(nextLevel);
				return {
					current: { provider: m.provider, id: m.id },
					thinkingLevel: nextLevel,
					liveThinking: levels,
				};
			},
			setThinking: async (level) => {
				draftThinkingRef.current = level;
				setDraftThinking(level);
				const picked = parseModelRef(draftModelRef.current);
				const current = picked ? { provider: picked.provider, id: picked.id } : null;
				const curOpt = current
					? (cachedModelsRef.current.find((m) => m.id === current.id && (!current.provider || m.provider === current.provider)) ?? null)
					: null;
				return {
					current,
					thinkingLevel: level,
					liveThinking: curOpt ? resolveThinkingLevels(curOpt, null, level) : [],
				};
			},
		};
	}, [sessionId]);

	const activeModel = draftModel ?? parentCstate?.model ?? null;
	const activeThinking = draftThinking ?? parentCstate?.thinkingLevel ?? null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PullToRefresh onRefresh={() => state.reload(true)}>
				<LoadGate state={state}>
					{() => (
						<EmptyState
							icon={<MessagesSquare {...ICON} />}
							title="开始一段新的辅助对话"
							hint="在下面问一个问题，主对话会继续它自己的工作"
						/>
					)}
				</LoadGate>
			</PullToRefresh>
			<Composer
				key={NEW_DRAFT_KEY}
				draftKey={NEW_DRAFT_KEY}
				active={active}
				drafts={drafts}
				placeholder="问一个问题，开始辅助对话"
				draftInject={draftInject}
				model={activeModel}
				thinking={activeThinking}
				onModel={() => setPickerOpen(true)}
				onThinking={(el) => {
					setThinkingAnchor(el ?? null);
					setThinkingOpen(true);
				}}
				onSend={(msg, sentText, sentAtts) =>
					onCreate(msg, sentText, sentAtts, {
						model: draftModel,
						thinkingLevel: draftThinking,
					})
				}
			/>
			<ModelThinkingSheet
				open={active && pickerOpen}
				onClose={() => setPickerOpen(false)}
				source={draftModelSource}
				currentLevel={activeThinking}
				onFacts={(f) => {
					if (f.model !== undefined) setDraftModel(f.model ?? null);
					if (f.thinkingLevel !== undefined) setDraftThinking(f.thinkingLevel ?? null);
				}}
			/>
			<ThinkingSourcePopover
				open={active && thinkingOpen}
				onClose={() => setThinkingOpen(false)}
				anchorEl={thinkingAnchor}
				source={draftModelSource}
				currentLevel={activeThinking}
				onFacts={(f) => {
					if (f.thinkingLevel !== undefined) setDraftThinking(f.thinkingLevel ?? null);
				}}
			/>
		</div>
	);
}

/* ---------------------------------------------------------------- thread */

function ThreadView({
	parentId,
	threadId,
	embedded,
	active,
	drafts,
	initial,
	draftInject,
	handbackOpen,
	onCloseHandback,
	onCanHandbackChange,
}: {
	parentId: string;
	threadId: string;
	embedded: boolean;
	active: boolean;
	drafts: SidechatDraftController;
	initial?: SidechatMessage;
	draftInject: DraftInject | null;
	handbackOpen: boolean;
	onCloseHandback: () => void;
	onCanHandbackChange: (can: boolean) => void;
}) {
	const session = useSessions((s) => s.byId[threadId]);
	const [items, setItems] = useState<Item[]>([]);
	const [stats, setStats] = useState<Record<string, RequestStat>>({});
	const [pending, setPending] = useState<PendingMessage[]>(() =>
		initial ? [{ id: 0, text: initial.text, images: transcriptImages(initial.imagePaths.map((path) => ({ path }))) }] : [],
	);
	const pendingRef = useRef(pending);
	const nextPendingId = useRef(0);
	const seenUsers = useRef(new Set<string>());
	const transcript = useRef(EMPTY_TRANSCRIPT);
	const boundaryFound = useRef(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [runActive, setRunActive] = useState<boolean | null>(initial ? true : null);
	const [restoredTexts, setRestoredTexts] = useState<string[]>([]);
	const [showJump, setShowJump] = useState(false);
	const [cstate, setCstate] = useState<ComposerState | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const [thinkingAnchor, setThinkingAnchor] = useState<HTMLElement | null>(null);
	const [contextOpen, setContextOpen] = useState(false);
	const [contextAnchor, setContextAnchor] = useState<HTMLElement | null>(null);
	const [compacting, setCompacting] = useState(false);
	const [behavior, setBehavior] = usePref<StreamBehavior>("chat.streamBehavior", "followUp");
	const threadModelSource = useMemo(() => sessionModelSource(threadId), [threadId]);
	const inflight = useRef(false);
	const again = useRef(false);
	const alive = useRef(true);
	const fetchTimer = useRef(0);
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const updatePending = (next: PendingMessage[]) => {
		pendingRef.current = next;
		setPending(next);
	};

	const [handbackDraft, setHandbackDraft] = useState("");
	const [summarizing, setSummarizing] = useState(false);
	const [handbackSending, setHandbackSending] = useState(false);
	const summaryNonceRef = useRef(0);
	const fetchSeqRef = useRef(0);
	const [completedFetchSeq, setCompletedFetchSeq] = useState(0);
	const activeSummaryRef = useRef<{
		nonce: number;
		baselineCount: number;
		startFetchSeq: number;
		terminalFetchSeq: number | null;
		sawAgentEnd: boolean;
		awaitingContinuation: boolean;
		resynced: boolean;
		edited: boolean;
	} | null>(null);
	const handbackEditedRef = useRef(false);
	const prefilledForOpenRef = useRef(false);
	useEffect(() => {
		onCanHandbackChange(items.length > 0);
	}, [items.length, onCanHandbackChange]);

	// Opening handback sheet pre-fills an existing summary once per open without restoring cleared text or overwriting edits.
	useEffect(() => {
		if (!handbackOpen) {
			prefilledForOpenRef.current = false;
			return;
		}
		if (prefilledForOpenRef.current) return;
		prefilledForOpenRef.current = true;
		if (handbackEditedRef.current || activeSummaryRef.current) return;
		const reply = handbackReply(items);
		if (reply) setHandbackDraft(reply);
	}, [handbackOpen, items]);

	const fetchThread = useCallback(async () => {
		if (inflight.current) {
			again.current = true;
			return;
		}
		inflight.current = true;
		const fetchMine = ++fetchSeqRef.current;
		try {
			const c = transcript.current;
			const page = await api<TranscriptPage>(
				"GET",
				`/sessions/${q(threadId)}/transcript?from=${c.offset}${c.tailId ? `&tail=${q(c.tailId)}` : ""}`,
			);
			if (!alive.current) return;
			// The fork contains parent history until the last side-chat boundary arrives.
			if (page.reset) boundaryFound.current = false;
			let start = -1;
			for (let i = page.items.length - 1; i >= 0; i--) {
				if (page.items[i].kind === "user" && isSideChatPrompt(page.items[i].text)) {
					start = i;
					break;
				}
			}
			const raw = trimSideChatItems(page.items, !boundaryFound.current);
			if (start >= 0) boundaryFound.current = true;
			const next = mergePage(transcript.current, { ...page, reset: page.reset || start >= 0, items: raw }).state;
			transcript.current = next;
			setItems(next.items);
			setStats(next.stats);
			const pool = next.items.filter((it) => it.role === "user" && !seenUsers.current.has(it.id));
			for (const it of pool) seenUsers.current.add(it.id);
			updatePending(
				pendingRef.current.filter((p) => {
					const match = pool.findIndex((it) => it.text.trim() === p.text.trim());
					if (match < 0) return true;
					pool.splice(match, 1);
					return false;
				}),
			);
			setCompletedFetchSeq(fetchMine);
			setError(null);
		} catch (e) {
			if (alive.current) setError(errorMessage(e, "加载失败"));
		} finally {
			inflight.current = false;
			if (alive.current) setLoaded(true);
			if (again.current && alive.current) {
				again.current = false;
				void fetchThread();
			}
		}
	}, [threadId]);

	const scheduleFetch = useCallback(() => {
		if (fetchTimer.current || !alive.current || document.visibilityState === "hidden") return;
		fetchTimer.current = window.setTimeout(() => {
			fetchTimer.current = 0;
			void fetchThread();
		}, FETCH_INTERVAL_MS);
	}, [fetchThread]);

	const working = runActive ?? (session?.status === "working" || session?.status === "awaiting_answer" || session?.status === "awaiting_approval");
	useEffect(() => {
		if (session) setRunActive(session.status === "working" || session.status === "awaiting_answer" || session.status === "awaiting_approval");
	}, [session?.status]);

	const triggerSummarize = async () => {
		if (working && !summarizing) return;
		const nonce = ++summaryNonceRef.current;
		const baselineCount = items.filter((it) => it.role === "user" && it.text?.includes(HANDBACK_MARKER)).length;
		activeSummaryRef.current = {
			nonce,
			baselineCount,
			startFetchSeq: fetchSeqRef.current,
			terminalFetchSeq: null,
			sawAgentEnd: false,
			awaitingContinuation: false,
			resynced: false,
			edited: false,
		};
		setSummarizing(true);
		try {
			await api("POST", `/sessions/${q(threadId)}/prompt`, { text: HANDBACK_PROMPT });
			if (!alive.current || activeSummaryRef.current?.nonce !== nonce) return;
			setRunActive(true);
			scheduleFetch();
		} catch (e) {
			if (!alive.current || activeSummaryRef.current?.nonce !== nonce) return;
			activeSummaryRef.current = null;
			setSummarizing(false);
			toast(`整理失败：${errorMessage(e)}`, { kind: "error" });
		}
	};

	// Reconcile summary completion from either SSE agent_end or transcript/status resync.
	useEffect(() => {
		const req = activeSummaryRef.current;
		if (!req) return;
		const reply = nthHandbackReply(items, req.baselineCount);
		if (reply && !req.edited && reply.text) {
			setHandbackDraft(reply.text);
		}
		if (req.sawAgentEnd) {
			if (req.terminalFetchSeq !== null && completedFetchSeq > req.terminalFetchSeq) {
				activeSummaryRef.current = null;
				setSummarizing(false);
			}
			return;
		}
		if (req.resynced && !req.awaitingContinuation && reply && !working && !reply.streaming && completedFetchSeq > req.startFetchSeq) {
			activeSummaryRef.current = null;
			setSummarizing(false);
		}
	}, [items, working, loaded, completedFetchSeq]);
	const handbackTitle = session ? sessionName(session) : "辅助对话";
	const insertIntoParent = () => {
		const text = handbackDraft.trim();
		if (!text) return;
		if (embedded) {
			useRightDrawer.getState().sendToMainChat(parentId, {
				quote: text,
				sourceLabel: `辅助对话：${handbackTitle}`,
			});
			onCloseHandback();
			toast("已放进主对话输入框", { kind: "success" });
			return;
		}
		const note = `[来自辅助对话：${handbackTitle}]\n> ${text}`;
		const prev = loadUnsent(parentId);
		saveUnsent(parentId, prev ? `${prev}\n\n${note}` : note);
		onCloseHandback();
		toast("已放进主对话输入框", { kind: "success" });
		nav.push(paths.chat(parentId));
	};

	const sendDirectToParent = async () => {
		setHandbackSending(true);
		try {
			const note = `[来自辅助对话：${handbackTitle}]\n\n${handbackDraft.trim()}`;
			await api("POST", `/sessions/${q(parentId)}/prompt`, { text: note });
			onCloseHandback();
			toast("已发回主对话", { kind: "success" });
			if (embedded) useRightDrawer.getState().closeDrawer();
			else nav.push(paths.chat(parentId));
		} catch (e) {
			toast(`发送失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setHandbackSending(false);
		}
	};

	const fetchThreadState = useCallback(() => {
		void api<ComposerState>("GET", `/sessions/${q(threadId)}/composer-state`)
			.then((next) => {
				if (alive.current && next && typeof next === "object") setCstate(next);
			})
			.catch(() => {});
	}, [threadId]);

	const handleCompact = useCallback(async () => {
		if (compacting) return;
		setCompacting(true);
		try {
			await api("POST", `/sessions/${q(threadId)}/slash`, { name: "compact" }, { timeoutMs: LONG_TIMEOUT_MS });
			if (!alive.current) return;
			toast("上下文压缩完成", { kind: "success" });
			scheduleFetch();
			fetchThreadState();
		} catch (e) {
			if (alive.current) toast(`压缩失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			if (alive.current) setCompacting(false);
		}
	}, [compacting, threadId, scheduleFetch, fetchThreadState]);

	useEffect(() => {
		alive.current = true;
		void fetchThread();
		fetchThreadState();
		const off = events.on("rpc", (d) => {
			if (d.sessionId !== threadId) return;
			if (d.frame.type === "agent_start" || d.frame.type === "turn_start") {
				setRunActive(true);
				if (activeSummaryRef.current) activeSummaryRef.current.awaitingContinuation = false;
			}
			if ((d.frame.type === "agent_end" && (d.frame.isTerminal !== false || d.frame.awaitingAsyncWork === true)) || (d.frame.type === "turn_end" && d.frame.isTerminal === true)) {
				setRunActive(false);
				fetchThreadState();
			}
			if (activeSummaryRef.current && d.frame.type === "agent_end") {
				if (d.frame.isTerminal === false) {
					activeSummaryRef.current.awaitingContinuation = true;
				} else {
					activeSummaryRef.current.awaitingContinuation = false;
					activeSummaryRef.current.sawAgentEnd = true;
					activeSummaryRef.current.terminalFetchSeq = fetchSeqRef.current;
				}
			}
			scheduleFetch();
		});
		const onVisibility = () => {
			window.clearTimeout(fetchTimer.current);
			fetchTimer.current = 0;
			if (document.visibilityState === "visible") {
				void fetchThread();
				fetchThreadState();
			}
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			alive.current = false;
			off();
			window.clearTimeout(fetchTimer.current);
			fetchTimer.current = 0;
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [threadId, fetchThread, fetchThreadState, scheduleFetch]);
	useResync(() => {
		if (activeSummaryRef.current) {
			activeSummaryRef.current.resynced = true;
			activeSummaryRef.current.awaitingContinuation = false;
		}
		void fetchThread();
		fetchThreadState();
	});

	// Keep pinned to the bottom unless the user scrolled up.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on content change
	useEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [items, pending]);
	useEffect(() => {
		const el = scroller.current;
		const body = content.current;
		if (!el || !body) return;
		const observer = new ResizeObserver(() => {
			if (stick.current) el.scrollTop = el.scrollHeight;
			setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight >= 80);
		});
		observer.observe(el);
		observer.observe(body);
		return () => observer.disconnect();
	}, []);

	const send = async (msg: SidechatMessage, sentText: string, sentAtts: readonly SidechatAttachment[]): Promise<boolean> => {
		if (!loaded) return false;
		const id = ++nextPendingId.current;
		updatePending([...pendingRef.current, { id, text: msg.text, images: transcriptImages(msg.imagePaths.map((path) => ({ path }))) }]);
		stick.current = true;
		setRunActive(true);
		try {
			await api("POST", `/sessions/${q(threadId)}/prompt-ex`, {
				text: msg.text,
				images: msg.images,
				...(working ? { streamingBehavior: behavior } : {}),
			});
			drafts.consumeSent(threadId, sentText, sentAtts);
			if (!alive.current) return true;
			scheduleFetch();
			return true;
		} catch (e) {
			if (!alive.current) return false;
			updatePending(pendingRef.current.filter((p) => p.id !== id));
			if (!working) setRunActive(false);
			toast(`发送失败：${errorMessage(e)}`, { kind: "error" });
			return false;
		}
	};

	const pct = cstate ? resolveContextPercent(cstate) : null;
	const ctxTone = contextTone(pct);
	const visible = items.length > MAX_ROWS ? items.slice(-MAX_ROWS) : items;
	return (
		<>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="relative flex min-h-0 flex-1 flex-col">
					<div
						ref={scroller}
						onScroll={(e) => {
							const el = e.currentTarget;
							stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
							setShowJump(!stick.current);
						}}
						className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-3 pb-4"
					>
						<div ref={content} className="space-y-5">
							{!loaded && <Loading />}
							{loaded && error !== null && items.length === 0 && (
								<ErrorState message={error} onRetry={() => void fetchThread()} />
							)}
							{error && items.length > 0 && (
								<div role="alert" className="space-y-2 rounded-m-lg bg-m-danger-bg p-3 text-m-sm text-m-danger [overflow-wrap:anywhere]">
									<p>{error}</p>
									<Button size="sm" onClick={() => void fetchThread()}>重试加载</Button>
								</div>
							)}
							{loaded && error === null && items.length === 0 && pending.length === 0 && !working && (
								<EmptyState icon={<MessagesSquare {...ICON} />} title="暂无消息" hint="在下方输入问题继续这段辅助对话" />
							)}
							{items.length > MAX_ROWS && (
								<div className="text-center text-m-xs text-m-text-3">只显示最近 {MAX_ROWS} 条</div>
							)}
							{visible.map((it, idx) => (
								<ThreadRow
									key={it.id}
									item={it}
									sessionId={threadId}
									working={working}
									isLast={idx === visible.length - 1}
									stat={stats[it.id]}
								/>
							))}
							{pending.map((p) => (
								<UserBubble key={`p${p.id}`} text={p.text} images={p.images} sessionId={threadId} dim />
							))}
							{working && <div className="m-shimmer text-m-sm text-m-text-3">思考中</div>}
						</div>
					</div>
					{showJump && (
						<div className="absolute bottom-2 left-1/2 -translate-x-1/2">
							<IconButton
								variant="filled"
								label="回到底部"
								icon={<ArrowDown size={20} />}
								onClick={() => {
									stick.current = true;
									if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
									setShowJump(false);
								}}
							/>
						</div>
					)}
				</div>
				<Composer
					key={threadId}
					draftKey={threadId}
					active={active}
					drafts={drafts}
					placeholder="继续追问"
					draftInject={draftInject}
					onSend={send}
					disabled={!loaded}
					working={working}
					behavior={behavior}
					onToggleBehavior={() => setBehavior(behavior === "followUp" ? "steer" : "followUp")}
					model={cstate?.model ?? null}
					thinking={cstate?.thinkingLevel ?? null}
					onModel={() => setPickerOpen(true)}
					onThinking={(el) => {
						setThinkingAnchor(el ?? null);
						setThinkingOpen(true);
					}}
					contextText={formatContextPercent(pct) ?? "未知"}
					contextPercent={pct}
					contextToneClass={TONE_TEXT[ctxTone]}
					onContext={(el) => {
						setContextAnchor(el);
						setContextOpen(true);
					}}
					restoredTexts={restoredTexts}
					onStop={async () => {
						try {
							const result = await api<{ restoredTexts?: string[] }>("POST", `/sessions/${q(threadId)}/abort`);
							if (!alive.current) return;
							const restored = (result.restoredTexts ?? []).map((text) => text.trim()).filter(Boolean);
							const pool = restored.slice();
							updatePending(
								pendingRef.current.filter((p) => {
									const index = pool.indexOf(p.text.trim());
									if (index < 0) return true;
									pool.splice(index, 1);
									return false;
								}),
							);
							if (restored.length) setRestoredTexts(restored);
							setRunActive(false);
							scheduleFetch();
						} catch (e) {
							toast(`停止失败：${errorMessage(e)}`, { kind: "error" });
						}
					}}
				/>
			</div>
			<ModelThinkingSheet
				open={active && pickerOpen}
				onClose={() => setPickerOpen(false)}
				source={threadModelSource}
				currentLevel={cstate?.thinkingLevel ?? null}
				contextTokens={cstate?.contextTokens}
				onFacts={(f) => setCstate((prev) => ({ ...(prev ?? {}), ...(f.model ? { model: f.model } : {}), thinkingLevel: f.thinkingLevel }))}
			/>
			<ThinkingSourcePopover
				open={active && thinkingOpen}
				onClose={() => setThinkingOpen(false)}
				anchorEl={thinkingAnchor}
				source={threadModelSource}
				currentLevel={cstate?.thinkingLevel ?? null}
				onFacts={(f) => setCstate((prev) => ({ ...(prev ?? {}), thinkingLevel: f.thinkingLevel }))}
			/>
			<ContextSheet
				open={active && contextOpen}
				onClose={() => setContextOpen(false)}
				anchorEl={contextAnchor}
				sessionId={threadId}
				cstate={cstate}
				compacting={compacting}
				onCompact={handleCompact}
			/>
			<BottomSheet
				open={active && handbackOpen}
				onClose={onCloseHandback}
				title="发回主对话"
				footer={
					<div className="space-y-1.5 px-4 pt-2 pb-3">
						{!handbackDraft.trim() && !summarizing && (
							<p className="text-center text-m-xs text-m-text-3">请先输入结论内容或点击「AI 总结」</p>
						)}
						<div className="flex gap-2">
							<Button
								variant="tonal"
								className="flex-1"
								disabled={!handbackDraft.trim() || handbackSending || summarizing}
								onClick={insertIntoParent}
							>
								放进输入框
							</Button>
							<Button
								variant="primary"
								className="flex-1"
								busy={handbackSending}
								disabled={!handbackDraft.trim() || summarizing}
								onClick={() => void sendDirectToParent()}
							>
								直接发送
							</Button>
						</div>
					</div>
				}
			>
				<div className="px-4 pb-2">
					<div className="mb-3 flex items-center justify-between gap-3 px-1">
						<span className="text-m-xs font-medium whitespace-nowrap text-m-text-3">手动编辑 · 或使用 AI 总结</span>
						<Button
							variant="tonal"
							icon={<Sparkles size={16} strokeWidth={1.75} />}
							busy={summarizing}
							disabled={working && !summarizing}
							onClick={() => void triggerSummarize()}
						>
							{handbackDraft ? "重新 AI 总结" : "AI 总结"}
						</Button>
					</div>
					{working && !summarizing && (
						<p className="mb-2 px-1 text-m-xs text-m-text-3">辅助对话正在回复中，完成后可使用「AI 总结」</p>
					)}
					{summarizing && (
						<div className="m-shimmer mb-3 px-1 text-m-sm text-m-text-3">正在整理结论，请稍候…</div>
					)}
					<textarea
						value={handbackDraft}
						onChange={(e) => {
							handbackEditedRef.current = true;
							if (activeSummaryRef.current) activeSummaryRef.current.edited = true;
							setHandbackDraft(e.target.value);
						}}
						rows={7}
						aria-label="结论"
						placeholder="手动输入要发回主对话的结论，或点击右上角「AI 总结」"
						className={`${inputCls} block resize-none rounded-m-lg`}
					/>
					<p className="px-1 pt-2 text-m-xs text-m-text-3">「放进输入框」只放进主对话草稿，不会自动发送；「直接发送」会立刻发给主对话。</p>
				</div>
			</BottomSheet>
		</>
	);
}

function UserBubble({ text, images = [], sessionId, dim = false }: { text: string; images?: ImageRef[]; sessionId: string; dim?: boolean }) {
	if (!text && !images.length) return null;
	return (
		<div className="flex justify-end">
			<div className={`m-selectable max-w-[var(--m-user-bubble-max)] rounded-(--m-bubble-radius) bg-m-bubble-user-bg px-4 py-2.5 text-m-body leading-[1.54] break-words whitespace-pre-wrap text-m-bubble-user-text [overflow-wrap:anywhere] ${dim ? "opacity-60" : ""}`}>
				{text}
				<Images sessionId={sessionId} images={images} />
			</div>
		</div>
	);
}

function Disclosure({
	label,
	defaultOpen = false,
	children,
}: {
	label: string;
	defaultOpen?: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	useEffect(() => {
		if (defaultOpen) setOpen(true);
	}, [defaultOpen]);
	return (
		<div className="min-w-0">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="-mx-1.5 inline-flex min-h-8 items-center gap-1 rounded-m-pill px-1.5 text-m-xs font-medium whitespace-nowrap text-m-text-faint transition-colors duration-(--m-dur-fast) active:bg-m-surface-hover active:text-m-text"
			>
				<span>{label}</span>
				<ChevronRight
					size={13}
					strokeWidth={1.85}
					aria-hidden
					className={`shrink-0 transition-transform duration-(--m-dur-fast) ${open ? "rotate-90" : ""}`}
				/>
			</button>
			{open && <div className="mt-1 space-y-2 border-l border-m-border pl-3">{children}</div>}
		</div>
	);
}

const ThreadRow = memo(function ThreadRow({
	item,
	sessionId,
	working,
	isLast,
	stat,
}: {
	item: Item;
	sessionId: string;
	working: boolean;
	isLast: boolean;
	stat?: RequestStat;
}) {
	if (item.role === "user") return <UserBubble text={item.text} images={item.images} sessionId={sessionId} />;
	if (item.role !== "assistant" && !item.tools.length) return null;

	const rowStreaming = isLast && working;
	const hasTools = item.tools.length > 0;
	const hasToolAttention = item.tools.some((t) => {
		const st = toolState(t, working);
		return st === "run" || st === "bad";
	});
	const resolvedStat = stat ?? requestStatFromItem(item);
	const statParts = resolvedStat ? formatDesktopStatParts(resolvedStat, { omitTime: true }) : [];
	const parsedTs = item.ts ? Date.parse(item.ts) : Number.NaN;
	const clockText = Number.isFinite(parsedTs) ? formatStatClock(parsedTs).slice(0, 5) : "";

	return (
		<div className="min-w-0 space-y-2">
			{hasTools ? (
				<Disclosure
					label={hasToolAttention && rowStreaming ? "处理中" : "已处理"}
					defaultOpen={hasToolAttention || !item.text}
				>
					{item.thinking && <Thinking id={`side-${sessionId}-${item.id}`} text={item.thinking} live={false} />}
					{item.tools.map((t) => (
						<ToolCard key={t.id} id={`side-${sessionId}-${t.id}`} tool={t} state={toolState(t, working)} />
					))}
				</Disclosure>
			) : (
				item.thinking && <Thinking id={`side-${sessionId}-${item.id}`} text={item.thinking} live={false} />
			)}
			{item.text && (
				<div className="m-selectable">
					<Markdown text={item.text} className="m-msg" streaming={rowStreaming} />
				</div>
			)}
			<Images sessionId={sessionId} images={item.images} />
			{!rowStreaming && statParts.length > 0 && (
				<div className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] leading-5 text-m-text-quiet tabular-nums">
					{statParts.map((p) => (
						<span key={p.field}>{p.glyph}{p.text}</span>
					))}
				</div>
			)}
			{!rowStreaming && item.text && (
				<div className="-ml-1.5 flex items-center gap-1.5 pt-0.5">
					{clockText && (
						<span className="pl-1.5 text-[11px] leading-4 text-m-text-faint tabular-nums">{clockText}</span>
					)}
					<button
						type="button"
						aria-label="复制"
						title="复制"
						onClick={() => void copyText(item.text).then((ok) => toast(ok ? "已复制" : "复制失败", { kind: ok ? "success" : "error" }))}
						className="m-press inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-m-text-faint active:bg-m-surface-hover active:text-m-text"
					>
						<Copy size={14} strokeWidth={1.75} aria-hidden />
					</button>
				</div>
			)}
		</div>
	);
});

/** Child-session adapter: shared IME/voice capsule, real uploads, and no main-chat store mutations. */
function Composer({
	draftKey,
	active,
	drafts,
	placeholder,
	onSend,
	draftInject = null,
	working = false,
	disabled = false,
	behavior = "followUp",
	onToggleBehavior,
	model,
	thinking,
	onModel,
	onThinking,
	contextText,
	contextPercent,
	contextToneClass,
	onContext,
	restoredTexts,
	onStop,
}: {
	draftKey: string;
	active: boolean;
	drafts: SidechatDraftController;
	placeholder: string;
	onSend: (message: SidechatMessage, sentText: string, sentAtts: readonly SidechatAttachment[]) => Promise<boolean>;
	draftInject?: DraftInject | null;
	working?: boolean;
	disabled?: boolean;
	behavior?: StreamBehavior;
	onToggleBehavior?: () => void;
	model?: string | null;
	thinking?: string | null;
	onModel?: (anchor?: HTMLElement | null) => void;
	onThinking?: (anchor?: HTMLElement | null) => void;
	contextText?: string | null;
	contextPercent?: number | null;
	contextToneClass?: string;
	onContext?: (anchor: HTMLElement | null) => void;
	restoredTexts?: string[];
	onStop?: () => Promise<void>;
}) {
	const apiRef = useRef<ComposerApi | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	const editVersion = useRef(0);
	const sendingText = useRef<{ text: string; version: number } | null>(null);
	const atts = drafts.getAtts(draftKey);
	const initialDraftText = useRef(drafts.getText(draftKey));

	useEffect(() => {
		if (!draftInject || draftInject.targetKey !== draftKey) return;
		if (!drafts.markInjectConsumed(draftInject.nonce)) return;
		const cur = apiRef.current?.get() ?? "";
		const next = cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n${draftInject.text}` : draftInject.text;
		apiRef.current?.set(next, true);
		drafts.setText(draftKey, next);
	}, [draftInject, drafts, draftKey]);

	useEffect(() => {
		if (!restoredTexts?.length) return;
		const current = apiRef.current?.get() ?? "";
		const keep = current.trim() && !(sendingText.current?.text === current && sendingText.current.version === editVersion.current && restoredTexts.includes(current.trim()));
		const next = [...(keep ? [current] : []), ...restoredTexts].join("\n\n");
		apiRef.current?.set(next);
		drafts.setText(draftKey, next);
	}, [restoredTexts, drafts, draftKey]);

	const [sending, setSending] = useState(false);
	const sendingRef = useRef(false);
	const [plusOpen, setPlusOpen] = useState(false);
	const [plusAnchor, setPlusAnchor] = useState<HTMLElement | null>(null);
	const alive = useRef(true);
	const fileAny = useRef<HTMLInputElement>(null);
	const fileCamera = useRef<HTMLInputElement>(null);
	const fileGallery = useRef<HTMLInputElement>(null);

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	useEffect(() => {
		if (!active) setPlusOpen(false);
	}, [active]);

	const pickFiles = (input: HTMLInputElement) => {
		const files = Array.from(input.files ?? []);
		input.value = "";
		drafts.addFiles(draftKey, files);
	};

	const submit = async (text: string) => {
		if (sendingRef.current || disabled) return;
		const currentAtts = drafts.getAtts(draftKey);
		const blocker = attachmentBlocker(currentAtts);
		if (blocker) {
			toast(blocker, { kind: "error" });
			return;
		}
		const prompt = buildPrompt(text.trim(), currentAtts);
		if (!prompt) return;
		sendingRef.current = true;
		const version = editVersion.current;
		sendingText.current = { text, version };
		setSending(true);
		try {
			const ok = await onSend(
				{
					text: prompt,
					imagePaths: currentAtts.flatMap((att) => (att.isImage && att.path ? [att.path] : [])),
					images: currentAtts.flatMap((att) => (att.image ? [att.image] : [])),
				},
				text,
				currentAtts,
			);
			if (ok && alive.current) {
				if (editVersion.current === version && apiRef.current?.get() === text) apiRef.current.clear();
				drafts.consumeSent(draftKey, text, currentAtts);
			}
		} finally {
			sendingText.current = null;
			sendingRef.current = false;
			if (alive.current) setSending(false);
		}
	};

	const attachments =
		atts.length > 0 ? (
			<div className="flex max-h-[24vh] min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain pb-2">
				{atts.map((att) => (
					<div key={att.id} className="min-w-0 space-y-2 rounded-m-md bg-m-surface p-2">
						<div className="flex min-w-0 items-center gap-2">
							{att.isImage ? (
								<img src={att.url} alt={att.name} className="h-12 w-12 shrink-0 rounded-m-sm object-cover" />
							) : (
								<FileText size={24} className="shrink-0 text-m-text-2" />
							)}
							<span className="min-w-0 flex-1 text-m-xs text-m-text [overflow-wrap:anywhere]">{att.name}</span>
						</div>
						<span
							role="status"
							className={`block text-m-xs ${att.status === "err" ? "text-m-danger [overflow-wrap:anywhere]" : "whitespace-nowrap text-m-text-3"}`}
						>
							{att.status === "up" ? "上传中" : att.status === "err" ? att.err : "已上传"}
						</span>
						<div className="flex shrink-0 items-center justify-end gap-2 whitespace-nowrap">
							{att.status === "err" && (
								<IconButton label={`重试上传 ${att.name}`} icon={<RefreshCw size={18} />} disabled={sending} onClick={() => drafts.retryAtt(draftKey, att)} />
							)}
							<IconButton label={`移除 ${att.name}`} icon={<X size={18} />} disabled={sending} onClick={() => drafts.removeAtt(draftKey, att)} />
						</div>
					</div>
				))}
			</div>
		) : undefined;

	return (
		<div ref={wrapRef} className="shrink-0 px-4 pt-1" style={{ paddingBottom: "calc(var(--m-safe-bottom) + 8px)" }}>
			{working && onToggleBehavior && (
				<div className="mb-1.5 flex items-center justify-between gap-2 px-2.5 text-m-xs">
					<button
						type="button"
						aria-label={`发送方式：${BEHAVIOR_LABEL[behavior]}，点击切换`}
						title={BEHAVIOR_HINT[behavior]}
						onClick={onToggleBehavior}
						className="inline-flex items-center gap-1.5 font-medium whitespace-nowrap text-m-text active:opacity-70"
					>
						<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-m-accent m-pulse" />
						<span>{BEHAVIOR_LABEL[behavior]} ⇄</span>
					</button>
				</div>
			)}
			<ComposerCapsule
				apiRef={apiRef}
				placeholder={placeholder}
				initialText={initialDraftText.current}
				busy={sending || disabled}
				working={working}
				hasExtra={atts.length > 0}
				top={attachments}
				model={model}
				thinking={thinking}
				onModel={onModel}
				onThinking={onThinking}
				contextText={contextText}
				contextPercent={contextPercent}
				contextToneClass={contextToneClass}
				onContext={
					onContext
						? () =>
								onContext(
									wrapRef.current?.querySelector<HTMLElement>('button[aria-label^="上下文用量"]') ?? null,
								)
						: undefined
				}
				onInput={() => {
					editVersion.current++;
				}}
				onSync={(val) => drafts.setText(draftKey, val)}
				onUnmount={(val) => drafts.setText(draftKey, val)}
				onPlus={() => {
					setPlusAnchor(wrapRef.current?.querySelector<HTMLElement>('button[aria-label="添加"]') ?? wrapRef.current);
					setPlusOpen(true);
				}}
				onSend={(text) => void submit(text)}
				onStop={onStop ? () => void onStop() : undefined}
			/>
			<input ref={fileAny} type="file" multiple hidden onChange={(e) => pickFiles(e.currentTarget)} />
			<input ref={fileCamera} type="file" accept="image/png,image/jpeg,image/gif,image/webp" capture="environment" hidden onChange={(e) => pickFiles(e.currentTarget)} />
			<input ref={fileGallery} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => pickFiles(e.currentTarget)} />
			<AnchoredPopover
				open={active && plusOpen}
				onClose={() => setPlusOpen(false)}
				anchorEl={plusAnchor}
				placement="top-start"
				title="添加附件"
				minWidth={230}
				maxWidth={280}
			>
				<div className="grid grid-cols-3 gap-2 p-3">
					<ActionTile icon={<Paperclip size={22} />} label="文件" disabled={sending} onClick={() => { setPlusOpen(false); fileAny.current?.click(); }} />
					<ActionTile icon={<Camera size={22} />} label="拍照" disabled={sending} onClick={() => { setPlusOpen(false); fileCamera.current?.click(); }} />
					<ActionTile icon={<ImagePlus size={22} />} label="相册" disabled={sending} onClick={() => { setPlusOpen(false); fileGallery.current?.click(); }} />
				</div>
			</AnchoredPopover>
		</div>
	);
}
