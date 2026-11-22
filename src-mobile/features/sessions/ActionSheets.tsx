import { Archive, ArchiveRestore, Check, Copy, FolderInput, GitBranch, MessageSquare, Pencil, Pin, PinOff, Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { nav, paths } from "../../core/nav";
import { copyText, sessionName } from "../../core/lib/format";
import { isDraftId } from "../../core/types";
import { AnchoredPopover, BottomSheet, Button, MenuRow, TextField, confirm, toast, type AnchorBox, type PopoverPlacement } from "../../ui";
import { assignToWorkspace, discardDraft, patchSession } from "./actions";
import { api, errorMessage } from "../../core/api";
import { useTree } from "./treeStore";
import { needsAttn, type DirEntry, type TreeSession } from "./tree";

export interface SheetItem {
	key: string;
	label: ReactNode;
	icon?: ReactNode;
	hint?: ReactNode;
	danger?: boolean;
	/** Current choice: drawn with a check mark. */
	active?: boolean;
	run: () => void;
}

const ICON = { size: 22, strokeWidth: 1.75 } as const;

/** ChatGPT-style menu sheet: flat `MenuRow`s, destructive rows always last. Tapping a row closes the sheet first. */
export function ActionSheet({
	open,
	title,
	subtitle,
	items,
	onClose,
	anchorEl,
	anchorRect,
	placement = "bottom-start",
	mode = "popover",
}: {
	open: boolean;
	title?: ReactNode;
	subtitle?: ReactNode;
	items: SheetItem[];
	onClose: () => void;
	anchorEl?: HTMLElement | null;
	anchorRect?: AnchorBox | null;
	placement?: PopoverPlacement;
	mode?: "popover" | "sheet";
}) {
	const ordered = [...items.filter((it) => !it.danger), ...items.filter((it) => it.danger)];
	const list = (
		<div className="py-1.5">
			{ordered.map((it) => (
				<MenuRow
					key={it.key}
					icon={it.icon}
					label={it.label}
					hint={it.hint}
					danger={it.danger}
					selected={it.active}
					right={it.active ? <Check size={20} className="text-m-accent" aria-label="当前" /> : undefined}
					onClick={() => {
						onClose();
						it.run();
					}}
				/>
			))}
		</div>
	);
	if (mode === "sheet") {
		return (
			<BottomSheet open={open} onClose={onClose} title={title} subtitle={subtitle}>
				{list}
			</BottomSheet>
		);
	}
	return (
		<AnchoredPopover
			open={open}
			onClose={onClose}
			anchorEl={anchorEl}
			anchorRect={anchorRect}
			placement={placement}
			title={title}
			subtitle={subtitle}
			maxWidth={330}
			minWidth={220}
		>
			{list}
		</AnchoredPopover>
	);
}

function PromptForm({
	initial,
	placeholder,
	onDone,
}: {
	initial: string;
	placeholder?: string;
	onDone: (value: string | null) => void;
}) {
	const [value, setValue] = useState(initial);
	return (
		<form
			className="flex flex-col gap-4 px-4 pt-2 pb-3"
			onSubmit={(e) => {
				e.preventDefault();
				onDone(value.trim());
			}}
		>
			<TextField aria-label="会话名称" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} />
			<div className="flex gap-3">
				<Button variant="tonal" block className="flex-1" onClick={() => onDone(null)}>
					取消
				</Button>
				<Button variant="primary" type="submit" block className="flex-1">
					确定
				</Button>
			</div>
		</form>
	);
}

/** Text prompt sheet (old `promptSheet`): reports the trimmed text, or null on cancel. */
export function PromptSheet({
	open,
	title,
	initial,
	placeholder,
	onDone,
}: {
	open: boolean;
	title: string;
	initial: string;
	placeholder?: string;
	onDone: (value: string | null) => void;
}) {
	return (
		<BottomSheet open={open} onClose={() => onDone(null)} title={title}>
			{open && <PromptForm initial={initial} placeholder={placeholder} onDone={onDone} />}
		</BottomSheet>
	);
}

interface SheetState {
	title?: ReactNode;
	items: SheetItem[];
	anchorEl?: HTMLElement | null;
	anchorRect?: AnchorBox | null;
}

/** Session row actions (open / rename / pin / archive / draft discard). Render `node` once in the page. */
export function useSessionActions(onOpen?: (s: TreeSession) => void): { openActions: (s: TreeSession, anchorEl?: HTMLElement | null, anchorRect?: AnchorBox | null) => void; node: ReactNode } {
	const [sheet, setSheet] = useState<SheetState | null>(null);
	const [assign, setAssign] = useState<{ s: TreeSession; dirs: DirEntry[] } | null>(null);
	const [prompt, setPrompt] = useState<{ s: TreeSession; initial: string } | null>(null);
	const close = useCallback(() => setSheet(null), []);
	const lastPointer = useRef<{ el: HTMLElement | null; rect: AnchorBox | null; at: number } | null>(null);
	useEffect(() => {
		const record = (target: EventTarget | null, x: number, y: number) => {
			if (!(target instanceof Element)) return;
			const btn = target.closest("button");
			lastPointer.current = {
				el: btn instanceof HTMLElement ? btn : target instanceof HTMLElement ? target : null,
				rect: x !== 0 || y !== 0 ? { left: x - 4, top: y - 4, right: x + 4, bottom: y + 4, width: 8, height: 8 } : null,
				at: Date.now(),
			};
		};
		const onPointerDown = (e: PointerEvent) => record(e.target, e.clientX, e.clientY);
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) record(e.target, 0, 0);
		};
		document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
		document.addEventListener("keydown", onKeyDown, { capture: true });
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, []);
	// Keep the last content mounted while the popover/sheet plays its exit transition.
	const last = useRef<SheetState | null>(null);
	if (sheet) last.current = sheet;
	const shown = sheet ?? last.current;

	const openActions = useCallback((s: TreeSession, anchorEl?: HTMLElement | null, anchorRect?: AnchorBox | null) => {
		const recent = lastPointer.current && Date.now() - lastPointer.current.at < 1500 ? lastPointer.current : null;
		const resolvedEl = anchorEl ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : recent?.el ?? null);
		const resolvedRect = anchorRect ?? recent?.rect ?? null;
		const open: SheetItem = { key: "open", label: "打开", icon: <MessageSquare {...ICON} />, run: () => onOpen ? onOpen(s) : nav.push(paths.chat(s.id)) };
		if (isDraftId(s.id)) {
			setSheet({
				title: sessionName(s),
				anchorEl: resolvedEl,
				anchorRect: resolvedRect,
				items: [open, { key: "discard", label: "丢弃草稿", icon: <Trash2 {...ICON} />, danger: true, run: () => void discardDraft(s) }],
			});
			return;
		}
		const busy = needsAttn(s);
		setSheet({
			title: sessionName(s),
			anchorEl: resolvedEl,
			anchorRect: resolvedRect,
			items: [
				open,
				{
					key: "rename",
					label: "重命名",
					icon: <Pencil {...ICON} />,
					run: () => setPrompt({ s, initial: s.title === s.label ? "" : s.title }),
				},
				{
					key: "pin",
					label: s.pinned ? "取消置顶" : "置顶",
					icon: s.pinned ? <PinOff {...ICON} /> : <Pin {...ICON} />,
					run: () => void patchSession(s, { pinned: !s.pinned }),
				},
				{
					key: "assign", label: "归入工作区", icon: <FolderInput {...ICON} />,
					run: () => void (async () => {
						try {
							const result = await api<{ dirs: DirEntry[] }>("GET", "/left/dirs");
							const dirs = (result.dirs ?? []).filter((d) => d.kind === "workspace" && d.mode === useTree.getState().mode && d.workspaceId);
							if (!dirs.length) toast("当前空间还没有工作区");
							else setAssign({ s, dirs });
						} catch (error) { toast(`加载工作区失败：${errorMessage(error)}`, { kind: "error" }); }
					})(),
				},
				...(s.status === "interrupted" || s.status === "suspended" ? [{
					key: "resume", label: "恢复会话", icon: <Play {...ICON} />,
					run: () => void (async () => {
						try { await api("POST", `/sessions/${encodeURIComponent(s.id)}/resume`, {}); onOpen ? onOpen(s) : nav.push(paths.chat(s.id)); }
						catch (error) { toast(`恢复会话失败：${errorMessage(error)}`, { kind: "error" }); }
					})(),
				}] : []),
				{ key: "copy-id", label: "复制会话 ID", icon: <Copy {...ICON} />, run: () => void copyText(s.id).then((ok) => toast(ok ? "已复制会话 ID" : "复制失败", { kind: ok ? "success" : "error" })) },
				...(s.git?.branch ? [{ key: "copy-branch", label: "复制分支名", icon: <GitBranch {...ICON} />, run: () => void copyText(s.git!.branch!).then((ok) => toast(ok ? "已复制分支名" : "复制失败", { kind: ok ? "success" : "error" })) }] : []),
				s.archived
					? {
							key: "unarchive",
							label: "取消归档",
							icon: <ArchiveRestore {...ICON} />,
							run: () => void patchSession(s, { archived: false }, "已取消归档"),
						}
					: {
							key: "archive",
							label: "归档",
							icon: <Archive {...ICON} />,
							danger: true,
							run: () => {
								void (async () => {
									if (busy && !(await confirm({ message: "该会话正在运行或等待回复，确定要归档吗？", confirmText: "归档", danger: true }))) return;
									await patchSession(s, { archived: true }, "已归档");
								})();
							},
						},
			],
		});
	}, [onOpen]);

	const node = (
		<>
			<ActionSheet
				open={sheet !== null}
				title={shown?.title}
				items={shown?.items ?? []}
				anchorEl={shown?.anchorEl}
				anchorRect={shown?.anchorRect}
				placement="bottom-start"
				onClose={close}
			/>
			<ActionSheet
				mode="sheet"
				open={assign !== null}
				title="归入工作区"
				items={(assign?.dirs ?? []).map((d) => ({ key: d.path, label: d.label || d.path, hint: d.label ? <span className="break-all">{d.path}</span> : undefined, run: () => { if (assign && d.workspaceId) void assignToWorkspace([assign.s], d.workspaceId); } }))}
				onClose={() => setAssign(null)}
			/>
			<PromptSheet
				open={prompt !== null}
				title="重命名会话"
				initial={prompt?.initial ?? ""}
				placeholder="留空则恢复默认名称"
				onDone={(v) => {
					const p = prompt;
					setPrompt(null);
					if (p && v !== null) void patchSession(p.s, { customName: v }, "已重命名");
				}}
			/>
		</>
	);
	return { openActions, node };
}
