import { Check, ChevronDown, ChevronRight, MessageCircleQuestion, ShieldCheck } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";
import { pendingForm } from "../../../core/pendingUi";
import type { PendingEntry, PendingOption, ToolItem } from "../../../core/types";
import { BottomSheet, Button, inputCls, toast } from "../../../ui";
import { useChat, useChatUi } from "../ChatContext";
import { isBatchApprovable, showApproveAll } from "../lib/approvals";
import { findOpenAsks, isAnswerSubmittable, matchRequest, type AskAnswer, type AskMatch, type AskQuestion, type AskSpec } from "../lib/askDriver";

/** Answer recorded for a skipped question (the agent sees the user chose not to answer). */
const SKIPPED = "跳过这一题";

interface AskDraft extends AskAnswer {
	skipped?: boolean;
}

/** Drafts of an ask by tool-call id: survive the card remounting between omp's per-question requests. */
const askDrafts = new Map<string, (AskDraft | undefined)[]>();

function Card({
	icon,
	label,
	tone = "default",
	children,
}: {
	icon: ReactNode;
	label: ReactNode;
	tone?: "default" | "warn";
	children: ReactNode;
}) {
	const isWarn = tone === "warn";
	return (
		<div
			className={`rounded-m-lg border p-4 shadow-m-card ${
				isWarn ? "border-m-warn-border bg-m-warn-bg" : "border-m-border bg-m-card"
			}`}
			data-testid="pending-card"
		>
			<div className={`mb-2 flex min-h-6 flex-wrap items-center gap-2 text-m-xs font-medium ${isWarn ? "text-m-warn" : "text-m-text-3"}`}>
				<span className={`flex shrink-0 ${isWarn ? "text-m-warn" : "text-m-text-2"}`}>{icon}</span>
				{label}
			</div>
			{children}
		</div>
	);
}

function ErrorLine({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
	return (
		<div className="mt-3 flex items-center gap-2 rounded-m-md bg-m-danger-bg py-1 pr-1 pl-4 text-m-sm text-m-danger">
			<span className="min-w-0 flex-1">提交失败</span>
			<Button size="sm" variant="ghost" className="text-m-danger" busy={busy} onClick={onRetry}>
				重试
			</Button>
		</div>
	);
}

/** Runs one submission; remembers failure so the card can offer 重试 (the controller already toasted). */
function useSubmit() {
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState<(() => Promise<void>) | null>(null);
	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		setFailed(null);
		try {
			await fn();
		} catch {
			setFailed(() => fn);
		} finally {
			setBusy(false);
		}
	};
	return { busy, failed, run };
}

/** Radio / checkbox row, ≥ 52px, whole row tappable. */
function ChoiceRow({
	multi,
	on,
	label,
	description,
	recommended,
	onClick,
}: {
	multi: boolean;
	on: boolean;
	label: string;
	description?: string;
	recommended?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			role={multi ? "checkbox" : "radio"}
			aria-checked={on}
			onClick={onClick}
			className={`flex min-h-13 w-full items-center gap-3 rounded-m-md px-3 py-2.5 text-left transition-colors duration-(--m-dur-fast) ${
				on ? "bg-m-surface-2" : "active:bg-m-surface-hover"
			}`}
		>
			<span
				aria-hidden
				className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center border-2 ${multi ? "rounded-[7px]" : "rounded-m-pill"} ${
					on ? "border-m-accent bg-m-accent text-m-accent-text" : "border-m-border-strong"
				}`}
			>
				{on && (multi ? <Check size={14} strokeWidth={3} /> : <span className="h-2 w-2 rounded-m-pill bg-m-accent-text" />)}
			</span>
			<span className="min-w-0 flex-1 break-words">
				<span className="text-m-md text-m-text">{label}</span>
				{recommended && <span className="ml-2 whitespace-nowrap text-m-xs text-m-accent">推荐</span>}
				{description && <span className="mt-0.5 block text-m-sm text-m-text-3">{description}</span>}
			</span>
		</button>
	);
}

function Progress({ index, total }: { index: number; total: number }) {
	return (
		<span className="flex items-center gap-2" aria-label={`问题 ${index} / ${total}`}>
			<span className="whitespace-nowrap">
				问题 {index}/{total}
			</span>
			<span aria-hidden className="flex items-center gap-1">
				{Array.from({ length: total }, (_, i) => (
					<span key={i} className={`h-1.5 rounded-m-pill ${i + 1 === index ? "w-3 bg-m-accent" : i + 1 < index ? "w-1.5 bg-m-accent" : "w-1.5 bg-m-surface-2"}`} />
				))}
			</span>
		</span>
	);
}

/* ------------------------------------------------------------------ approvals */

/** Keep omp's exact option values; remembered grants are session-only unless explicitly Always. */
function approvalButtons(options: readonly PendingOption[]) {
	const raws = options.map((o) => o.raw);
	const hasOnce = raws.includes("Approve Once");
	const once = hasOnce ? "Approve Once" : raws.find((r) => r === "Approve");
	const deny = raws.find((r) => r === "Deny");
	const other = raws.filter((r) => r !== once && r !== deny).map((raw) => {
		let label = raw;
		if (raw === "Approve File") label = "本会话允许文件";
		else if (raw.startsWith("Approve Directory: ")) label = `本会话允许目录：${raw.slice(19)}`;
		else if (raw === "Approve") label = "本会话记住";
		else if (/^Approve .+ for this session$/.test(raw)) label = `本会话允许：${raw.slice(8, -17)}`;
		else if (raw === "Always Approve File") label = "始终允许文件";
		else if (raw.startsWith("Always Approve Directory: ")) label = `始终允许目录：${raw.slice(26)}`;
		else if (raw === "Always Approve") label = "始终允许";
		return { raw, label };
	});
	return { once, deny, other };
}

const ApprovalCard = memo(function ApprovalCard({ entry }: { entry: PendingEntry }) {
	const { controller } = useChatUi();
	const form = pendingForm(entry);
	const { busy, failed, run } = useSubmit();
	const [head, ...rest] = (form.title || "工具请求").split("\n");
	const detail = [rest.join("\n").trim(), form.message.trim()].filter(Boolean).join("\n\n");
	const longDetail = detail.length > 180 || detail.split("\n").length > 4;
	const [detailOpen, setDetailOpen] = useState(!longDetail);
	const confirmLike = form.method === "confirm";
	const b = approvalButtons(form.options);
	const verticalActions = b.other.some(({ label }) => label.length > 14);
	const send = (value: string) => run(() => controller.respond(entry, { value }));
	return (
		<Card tone="warn" icon={<ShieldCheck size={17} strokeWidth={2} />} label="需要你的批准">
			<div className="m-selectable break-words text-m-md font-medium text-m-text">{head}</div>
			{detail && (
				<div className="mt-2.5">
					{longDetail && (
						<button
							type="button"
							aria-expanded={detailOpen}
							onClick={() => setDetailOpen((v) => !v)}
							className="mb-1.5 inline-flex items-center gap-1 text-m-xs font-medium text-m-text-2 active:opacity-70"
						>
							{detailOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
							{detailOpen ? "收起详情" : "查看详情"}
						</button>
					)}
					{detailOpen && (
						<pre className="m-selectable mb-0 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-m-sm border border-m-border bg-m-card p-3 font-m-mono text-m-xs leading-5 text-m-text-2">
							{detail}
						</pre>
					)}
				</div>
			)}
			{failed && <ErrorLine busy={busy} onRetry={() => void run(failed)} />}
			<div className={`sticky bottom-0 z-10 -mx-4 mt-4 border-t border-m-border/70 bg-m-warn-bg/95 px-4 pt-3 pb-1 backdrop-blur-sm flex gap-2 ${verticalActions ? "flex-col items-stretch [&>button]:w-full" : "flex-wrap justify-end"}`}>
				{confirmLike ? (
					<>
						<Button disabled={busy} onClick={() => void run(() => controller.respond(entry, { confirmed: false }))}>
							拒绝
						</Button>
						<Button variant="primary" busy={busy} onClick={() => void run(() => controller.respond(entry, { confirmed: true }))}>
							允许
						</Button>
					</>
				) : (
					<>
						{b.deny && (
							<Button disabled={busy} onClick={() => void send(b.deny as string)}>
								拒绝
							</Button>
						)}
						{b.other.map(({ raw, label }) => (
							<Button
								key={raw}
								disabled={busy}
								onClick={() => void send(raw)}
								className={verticalActions ? "h-auto justify-start py-3 text-left whitespace-normal! [overflow-wrap:anywhere]" : ""}
							>
								{label}
							</Button>
						))}
						{b.once && (
							<Button variant="primary" busy={busy} onClick={() => void send(b.once as string)}>
								单次允许
							</Button>
						)}
					</>
				)}
			</div>
		</Card>
	);
});

/* ------------------------------------------------------------------ ask (all questions, local paging) */

function initialAnswer(q: AskQuestion): AskAnswer {
	const rec = q.recommended !== undefined && q.recommended >= 0 && q.recommended < q.options.length ? q.recommended : undefined;
	return { selected: !q.multi && rec !== undefined ? [q.options[rec].label] : [], custom: "" };
}

const AskCard = memo(function AskCard({ spec, match, entry }: { spec: AskSpec; match: AskMatch; entry: PendingEntry }) {
	const { controller } = useChatUi();
	const start = match.qIndex;
	const [answers, setAnswers] = useState<(AskDraft | undefined)[]>(() => {
		const kept = askDrafts.get(spec.toolCallId);
		return kept ?? spec.questions.map((q, i) => (i >= start ? initialAnswer(q) : undefined));
	});
	const [idx, setIdx] = useState(start);
	const { busy, failed, run } = useSubmit();
	const q = spec.questions[idx];
	const a = answers[idx] ?? initialAnswer(q);
	const last = idx === spec.questions.length - 1;

	const update = (next: AskDraft, at = idx) => {
		setAnswers((prev) => {
			const copy = prev.slice();
			copy[at] = next;
			askDrafts.set(spec.toolCallId, copy);
			return copy;
		});
	};

	const submit = (all: (AskDraft | undefined)[]) => {
		const missing = spec.questions.findIndex((qq, i) => i >= start && !all[i]?.skipped && !isAnswerSubmittable(qq, all[i] ?? initialAnswer(qq)));
		if (missing >= 0) {
			setIdx(missing);
			toast(`第 ${missing + 1} 题还没有回答`, { kind: "error" });
			return;
		}
		const filled = all.map((x, i) => (x?.skipped ? { selected: [], custom: SKIPPED } : i >= start ? (x ?? initialAnswer(spec.questions[i])) : x));
		void run(async () => {
			await controller.answerAsk(spec, filled, entry);
			askDrafts.delete(spec.toolCallId);
		});
	};

	const next = () => (last ? submit(answers) : setIdx(idx + 1));
	const skip = () => {
		const skipped: AskDraft = { ...a, skipped: true };
		const all = answers.slice();
		all[idx] = skipped;
		update(skipped);
		if (last) submit(all);
		else setIdx(idx + 1);
	};

	const toggle = (label: string) => {
		if (q.multi) {
			const on = a.selected.includes(label);
			update({ ...a, skipped: false, selected: on ? a.selected.filter((l) => l !== label) : [...a.selected, label] });
		} else {
			update({ selected: [label], custom: "" });
		}
	};

	return (
		<Card
			icon={<MessageCircleQuestion size={18} strokeWidth={1.75} />}
			label={
				<>
					{spec.questions.length > 1 ? <Progress index={idx + 1} total={spec.questions.length} /> : <span>需要你回答</span>}
					<span className="shrink-0 whitespace-nowrap rounded-m-pill bg-m-accent-soft px-2.5 py-0.5 text-m-accent-soft-text">{q.multi ? "多选" : "单选"}</span>
					{q.header && <span className="ml-auto min-w-0 break-words rounded-m-pill bg-m-surface-2 px-2.5 py-0.5 text-m-text-2">{q.header}</span>}
				</>
			}
		>
			<div className="m-selectable mb-2 break-words text-m-md font-medium">{q.question}</div>
			<div role={q.multi ? "group" : "radiogroup"} aria-label={q.multi ? "多选项" : "单选项"} className="-mx-1 flex flex-col gap-0.5">
				{q.options.map((o, i) => (
					<ChoiceRow
						key={o.label}
						multi={q.multi}
						on={a.selected.includes(o.label) && (q.multi || !a.custom.trim())}
						label={o.label}
						description={o.description}
						recommended={q.recommended === i}
						onClick={() => toggle(o.label)}
					/>
				))}
			</div>
			<input
				type="text"
				value={a.custom}
				onChange={(e) => update({ ...a, skipped: false, custom: e.target.value })}
				placeholder={q.multi ? "补充说明（可选）" : "其他回答（可选）"}
				aria-label={q.multi ? "补充说明" : "其他回答"}
				className={`${inputCls} mt-2 bg-m-bg!`}
			/>
			{failed && <ErrorLine busy={busy} onRetry={() => submit(answers)} />}
			<div className="sticky bottom-0 z-10 -mx-4 mt-4 flex items-center gap-2 border-t border-m-border/70 bg-m-card/95 px-4 pt-3 pb-1 backdrop-blur-sm">
				<Button variant="ghost" disabled={busy} onClick={skip}>
					跳过
				</Button>
				<span className="flex-1" />
				<Button disabled={busy || idx <= start} onClick={() => setIdx(idx - 1)}>
					上一题
				</Button>
				<Button variant="primary" busy={busy} onClick={next}>
					{last ? "提交" : "下一题"}
				</Button>
			</div>
		</Card>
	);
});

/* ------------------------------------------------------------------ generic select / text requests */

const QuestionCard = memo(function QuestionCard({ entry }: { entry: PendingEntry }) {
	const { controller } = useChatUi();
	const form = pendingForm(entry);
	const { busy, failed, run } = useSubmit();
	const options = form.options.filter((o) => !o.isDone && !o.isOther);
	const [text, setText] = useState(form.defaultValue);
	const [custom, setCustom] = useState("");
	const [radio, setRadio] = useState<string>(() => (options.find((o) => o.recommended) ?? options[0])?.raw ?? "");
	const [picked, setPicked] = useState<string[]>([]);

	const label = (
		<>
			{form.index != null && form.total != null ? <Progress index={form.index} total={form.total} /> : <span>需要你回答</span>}
			{!form.text && (
				<span className="shrink-0 whitespace-nowrap rounded-m-pill bg-m-accent-soft px-2.5 py-0.5 text-m-accent-soft-text">{form.multiple ? "多选" : "单选"}</span>
			)}
		</>
	);

	let body: ReactNode;
	let submit: () => Promise<void>;
	let canSubmit = true;
	if (form.text) {
		body = (
			<textarea
				value={text}
				onChange={(e) => setText(e.target.value)}
				placeholder={form.placeholder || "输入回复"}
				rows={3}
				className={`${inputCls} h-auto resize-none bg-m-bg!`}
			/>
		);
		submit = () => controller.respond(entry, { value: text });
		canSubmit = !(form.required && !text.trim());
	} else if (form.multiple) {
		body = (
			<div role="group" aria-label="多选项" className="-mx-1 flex flex-col gap-0.5">
				{options.map((o) => {
					const on = picked.includes(o.label);
					return (
						<ChoiceRow
							key={o.raw}
							multi
							on={on}
							label={o.label}
							description={o.description}
							recommended={o.recommended}
							onClick={() => setPicked(on ? picked.filter((x) => x !== o.label) : [...picked, o.label])}
						/>
					);
				})}
			</div>
		);
		submit = () => controller.respondMulti(entry, picked);
	} else {
		body = (
			<>
				<div role="radiogroup" aria-label="单选项" className="-mx-1 flex flex-col gap-0.5">
					{options.map((o) => (
						<ChoiceRow
							key={o.raw}
							multi={false}
							on={radio === o.raw && !custom.trim()}
							label={o.label}
							description={o.description}
							recommended={o.recommended}
							onClick={() => {
								setRadio(o.raw);
								setCustom("");
							}}
						/>
					))}
				</div>
				<input
					type="text"
					value={custom}
					onChange={(e) => setCustom(e.target.value)}
					placeholder="其他回答（可选）"
					aria-label="其他回答"
					className={`${inputCls} mt-2 bg-m-bg!`}
				/>
			</>
		);
		submit = () => controller.respond(entry, { value: custom.trim() || radio });
		canSubmit = !!(custom.trim() || radio);
	}

	return (
		<Card icon={<MessageCircleQuestion size={18} strokeWidth={1.75} />} label={label}>
			<div className="m-selectable mb-2 break-words text-m-md font-medium">{form.title || "请求"}</div>
			{form.message && <div className="m-selectable mb-2 whitespace-pre-wrap break-words text-m-sm text-m-text-2">{form.message}</div>}
			{body}
			{failed && <ErrorLine busy={busy} onRetry={() => void run(failed)} />}
			<div className="sticky bottom-0 z-10 -mx-4 mt-4 flex items-center justify-end gap-2 border-t border-m-border/70 bg-m-card/95 px-4 pt-3 pb-1 backdrop-blur-sm">
				<Button disabled={busy} onClick={() => void run(() => controller.respond(entry, { cancelled: true }))}>
					跳过
				</Button>
				<Button variant="primary" busy={busy} disabled={!canSubmit} onClick={() => void run(submit)}>
					提交
				</Button>
			</div>
		</Card>
	);
});

/** Tool calls of the newest turn (persisted + live): where an open `ask` call lives. */
function useOpenAsks(): AskSpec[] {
	const blocks = useChat((s) => s.blocks);
	const live = useChat((s) => s.live);
	return useMemo(() => {
		const tools: ToolItem[] = [];
		for (let i = blocks.length - 1; i >= 0; i--) {
			const b = blocks[i];
			if (b.type !== "turn") continue;
			for (const s of b.steps) if (s.kind === "tool") tools.push(s.tool);
			break;
		}
		if (live) tools.push(...live.tools);
		return findOpenAsks(tools);
	}, [blocks, live]);
}

function pendingBannerSummary(pendings: readonly PendingEntry[]): { isApproval: boolean; label: string; summary: string } {
	const first = pendings[0];
	const approvals = pendings.filter(isBatchApprovable).length;
	const isApproval = approvals > 0 && approvals === pendings.length;
	if (pendings.length > 1) {
		return {
			isApproval,
			label: isApproval ? `待批准 (${pendings.length})` : `待确认 (${pendings.length})`,
			summary: isApproval ? `${approvals} 个工具请求等待批准` : `${pendings.length} 项待处理请求`,
		};
	}
	const form = pendingForm(first);
	const firstLine = (form.title || (isApproval ? "工具请求" : "需要你回答")).split("\n")[0].trim();
	return {
		isApproval,
		label: isApproval ? "待确认" : "需要回答",
		summary: firstLine,
	};
}

export function PendingCards() {
	const { controller } = useChatUi();
	const pendings = useChat((s) => s.pendings);
	const asks = useOpenAsks();
	const pendingKey = pendings.map((p, i) => p.request?.id ?? `idx-${i}`).join("|");
	const [dismissedKey, setDismissedKey] = useState<string | null>(null);
	const [quickBusy, setQuickBusy] = useState(false);

	if (!pendings.length) return null;

	const sheetOpen = dismissedKey !== pendingKey;
	const approvals = pendings.filter(isBatchApprovable).length;
	const banner = pendingBannerSummary(pendings);
	const singleSimpleConfirm =
		!sheetOpen && pendings.length === 1 && isBatchApprovable(pendings[0]) && pendingForm(pendings[0]).method === "confirm";

	const quickRespond = async (confirmed: boolean) => {
		if (quickBusy) return;
		setQuickBusy(true);
		try {
			await controller.respond(pendings[0], { confirmed });
		} catch {
			// Controller already toasted; reopen full sheet so user can inspect or retry.
			setDismissedKey(null);
		} finally {
			setQuickBusy(false);
		}
	};

	return (
		<>
			{/* Compact bottom action banner above composer so conversation history is never crushed */}
			<div className="shrink-0 px-3.5 pt-1 pb-1.5">
				<div
					className={`flex min-h-11 items-center gap-2 rounded-m-md border px-3 py-1.5 shadow-m-card ${
						banner.isApproval ? "border-m-warn-border bg-m-warn-bg" : "border-m-border bg-m-card"
					}`}
				>
					<button
						type="button"
						onClick={() => setDismissedKey(null)}
						className="flex min-w-0 flex-1 items-center gap-2 text-left active:opacity-75"
					>
						<span className={`flex shrink-0 ${banner.isApproval ? "text-m-warn" : "text-m-accent"}`}>
							{banner.isApproval ? <ShieldCheck size={17} strokeWidth={2} /> : <MessageCircleQuestion size={17} strokeWidth={2} />}
						</span>
						<span className={`shrink-0 text-m-xs font-semibold ${banner.isApproval ? "text-m-warn" : "text-m-accent"}`}>
							{banner.label}
						</span>
						<span className="min-w-0 flex-1 truncate text-m-xs text-m-text-2">· {banner.summary}</span>
						{!singleSimpleConfirm && (
							<span className="inline-flex shrink-0 items-center gap-0.5 text-m-xs font-medium text-m-text">
								{sheetOpen ? "查看" : "处理"}
								<ChevronRight size={14} aria-hidden />
							</span>
						)}
					</button>
					{singleSimpleConfirm && (
						<div className="flex shrink-0 items-center gap-1.5">
							<button
								type="button"
								disabled={quickBusy}
								onClick={() => void quickRespond(false)}
								className="rounded-m-pill bg-m-surface px-2.5 py-1 text-m-xs font-medium text-m-text active:bg-m-surface-2 disabled:opacity-40"
							>
								拒绝
							</button>
							<button
								type="button"
								disabled={quickBusy}
								onClick={() => void quickRespond(true)}
								className="rounded-m-pill bg-m-text px-2.5 py-1 text-m-xs font-medium text-m-bg active:opacity-85 disabled:opacity-40"
							>
								允许
							</button>
						</div>
					)}
				</div>
			</div>

			{/* Focused decision drawer with collapsible details and sticky keyboard-safe action footer */}
			<BottomSheet
				open={sheetOpen}
				onClose={() => setDismissedKey(pendingKey)}
				title={banner.isApproval ? "待确认操作" : "需要你回答"}
			>
				<div className="space-y-3 px-4 pt-1 pb-4">
					{showApproveAll(pendings) && (
						<div className="flex flex-wrap items-center gap-2 rounded-m-lg bg-m-surface py-2 pr-2 pl-4">
							<span className="min-w-0 flex-1 text-m-sm text-m-text-2">{approvals} 个工具请求等待批准</span>
							<Button size="sm" onClick={() => void controller.approveAll("deny", pendings)}>
								全部拒绝
							</Button>
							<Button size="sm" variant="primary" onClick={() => void controller.approveAll("approve", pendings)}>
								全部允许
							</Button>
						</div>
					)}
					{pendings.map((p, i) => {
						if (isBatchApprovable(p)) return <ApprovalCard key={p.request?.id ?? i} entry={p} />;
						for (const spec of asks) {
							const m = matchRequest(spec, p.request);
							if (m) return <AskCard key={`ask-${spec.toolCallId}`} spec={spec} match={m} entry={p} />;
						}
						return <QuestionCard key={p.request?.id ?? i} entry={p} />;
					})}
				</div>
			</BottomSheet>
		</>
	);
}
