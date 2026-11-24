import { Check, ChevronLeft, FolderCog, Globe2 } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../core/api";
import { resolveThemeId, themeById } from "../../app/themes";
import { nav, paths } from "../../core/nav";
import { usePrefs } from "../../core/stores/prefs";
import { AnchoredPopover, Button, EmptyState, IconButton, ListGroup, ListRow, MenuRow, PullToRefresh, Spinner } from "../../ui";
import { OmpError, OmpSettingsGroup } from "./OmpSettings";
import { QUOTA_ITEM, SETTINGS_GROUPS, type SettingsItemDef, type SheetId } from "./settingsGroups";
import {
	AboutSheet,
	AppearanceSheet,
	AutomationSettingsSheet,
	ConnectionSheet,
	DoctorSheet,
	GeneralSheet,
	GuideSheet,
	McpSheet,
	MemorySheet,
	NotifySheet,
	PrivacySheet,
	PromptCompositionSheet,
	RulesFilesSheet,
	SessionsSheet,
	SubagentsSheet,
	ToolsSheet,
	WebSheet,
} from "./sheets";
import type { MobileInfo } from "./sheets/ConnectionSheet";
import { APPROVAL_MODES, isApprovalMode, isAutomationOverlapPolicy, SCHEMES, type ApprovalMode, type OmpValue } from "./settingsMap";

interface SettingsData {
	appVersion?: string | null;
	mobile?: MobileInfo;
	defaultModel?: string | null;
	defaultModelSource?: string | null;
	defaultApprovalMode?: string | null;
	automationBackgroundEnabled?: boolean;
	automationOverlapPolicy?: "skip" | "coalesce" | "queue" | "parallel" | null;
	automationDefaultResultMode?: "structured" | "llm_summary" | null;
	automationDefaultModel?: string | null;
	automationDefaultThinking?: string | null;
	automationPromptMockTest?: string | null;
	automationPromptRealOnceTest?: string | null;
	automationPromptRealLoopTest?: string | null;
	automationPromptAdjust?: string | null;
	omp?: Record<string, OmpValue>;
	ompError?: string | null;
}
interface DirEntry {
	path: string;
	label?: string;
}

/** Project scope for the roles / fallbacks sub-pages; survives navigating back to settings. */
let scopeCwd: string | null = null;

export const withCwd = (path: string, cwd: string | null): string => (cwd ? `${path}?cwd=${encodeURIComponent(cwd)}` : path);

const dirName = (d: DirEntry): string => d.label || d.path.split("/").filter(Boolean).pop() || d.path;

const ICON = { size: 22, strokeWidth: 1.75 } as const;

export function SettingsPage() {
	const [data, setData] = useState<SettingsData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [dirs, setDirs] = useState<DirEntry[]>([]);
	const [cwd, setCwd] = useState<string | null>(scopeCwd);
	const [scopeOpen, setScopeOpen] = useState(false);
	const [activeSheet, setActiveSheet] = useState<SheetId | null>(null);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
	const lastClickedRowRef = useRef<HTMLElement | null>(null);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const largeTitleRef = useRef<HTMLHeadingElement>(null);
	const [collapsed, setCollapsed] = useState(false);
	const scheme = usePrefs((s) => s.scheme);
	const lightTheme = usePrefs((s) => s.lightTheme);
	const darkTheme = usePrefs((s) => s.darkTheme);

	const load = useCallback(async () => {
		setError(null);
		try {
			const [s, dirsResult] = await Promise.all([
				api<SettingsData>("GET", "/left/settings"),
				api<{ dirs: DirEntry[] }>("GET", "/left/dirs").then(
					(res) => ({ ok: true as const, dirs: res.dirs ?? [] }),
					() => ({ ok: false as const, dirs: null }),
				),
			]);
			setData(s);
			if (dirsResult.ok) {
				setDirs(dirsResult.dirs);
				setCwd((prev) => {
					const target = scopeCwd ?? prev;
					if (target != null && !dirsResult.dirs.some((dir) => dir.path === target)) {
						scopeCwd = null;
						return null;
					}
					return prev;
				});
			}
		} catch (e) {
			setError(errorMessage(e, "加载设置失败"));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		const scroller = scrollerRef.current;
		const titleEl = largeTitleRef.current;
		if (!scroller || !titleEl) return;
		const update = () => {
			const titleRect = titleEl.getBoundingClientRect();
			const scrollerRect = scroller.getBoundingClientRect();
			if (titleRect.height === 0 || scrollerRect.height === 0) {
				const threshold = titleEl.offsetHeight || 40;
				const next = scroller.scrollTop > threshold;
				setCollapsed((prev) => (prev === next ? prev : next));
				return;
			}
			const next = titleRect.bottom <= scrollerRect.top + 4;
			setCollapsed((prev) => (prev === next ? prev : next));
		};
		update();
		let observer: IntersectionObserver | null = null;
		if (typeof IntersectionObserver !== "undefined") {
			observer = new IntersectionObserver(update, { root: scroller, threshold: [0, 0.05, 1] });
			observer.observe(titleEl);
		}
		scroller.addEventListener("scroll", update, { passive: true });
		window.addEventListener("resize", update);
		return () => {
			observer?.disconnect();
			scroller.removeEventListener("scroll", update);
			window.removeEventListener("resize", update);
		};
	}, []);


	const mode: ApprovalMode | null = isApprovalMode(data?.defaultApprovalMode) ? data.defaultApprovalMode : null;
	const automationOverlapPolicy = isAutomationOverlapPolicy(data?.automationOverlapPolicy) ? data.automationOverlapPolicy : null;
	const setOmp = useCallback((key: string, value: OmpValue) => setData((d) => (d ? { ...d, omp: { ...d.omp, [key]: value } } : d)), []);
	// Retain the selected instance on close for its exit animation and local draft.
	const close = () => setSheetOpen(false);
	const chooseScope = (next: string | null) => {
		scopeCwd = next;
		setCwd(next);
		setScopeOpen(false);
	};
	const scopeDir = cwd ? dirs.find((d) => d.path === cwd) : undefined;

	const open = (item: SettingsItemDef) => {
		switch (item.navigateTo) {
			case "settingsProviders":
				return nav.push(paths.settingsProviders());
			case "settingsRoles":
				return nav.push(withCwd(paths.settingsRoles(), cwd));
			case "settingsFallbacks":
				return nav.push(withCwd(paths.settingsFallbacks(), cwd));
			case "settingsContext":
				return nav.push(paths.settingsContext());
			case "quota":
				return nav.push(paths.quota());
			case "skills":
				return nav.push(paths.skills());
			case undefined:
				if (item.id === "inbox") return nav.push(paths.inbox());
				setAnchorEl(lastClickedRowRef.current);
				setActiveSheet(item.id as SheetId);
				setSheetOpen(true);
		}
	};

	/** Short current value shown at the right of a row. */
	const valueOf = (id: SettingsItemDef["id"]): string | undefined => {
		if (id === "appearance") {
			const modeLabel = SCHEMES.find((s) => s.value === scheme)?.label;
			if (scheme === "light") return `${modeLabel} · ${themeById(resolveThemeId("light", lightTheme))?.name ?? ""}`;
			if (scheme === "dark") return `${modeLabel} · ${themeById(resolveThemeId("dark", darkTheme))?.name ?? ""}`;
			return modeLabel;
		}
		if (id === "general" && mode) return APPROVAL_MODES.find((m) => m.value === mode)?.label;
		if (id === "connection" && data?.mobile) return data.mobile.running ? "已连接" : "未运行";
		if (id === "privacy" || id === "agents-md" || id === "subagents" || id === "memory" || id === "mcp" || id === "web") {
			return "电脑端管理";
		}
		if (id === "about") return data?.appVersion || "未知";
		return undefined;
	};

	const subtitleOf = (id: SettingsItemDef["id"]): string | undefined => {
		switch (id) {
			case "thinking":
				return "在对话顶部点模型名称，可切换当前会话的思考深度；采样参数由电脑端管理。";
			case "privacy":
				return "登记过的密钥与敏感信息在发给模型前自动脱敏";
			case "agents-md":
				return "全局与项目规则文件在电脑端查看和编辑";
			case "subagents":
				return "子代理定义在电脑端配置";
			case "memory":
				return "跨会话记忆在电脑端查看和编辑";
			case "mcp":
				return "外部工具和数据连接在电脑端配置";
			case "web":
				return "搜索服务商与密钥在电脑端配置";
			case "about":
				return "版本升级在电脑上进行，刷新页面即可同步";
			default:
				return undefined;
		}
	};

	const row = (item: SettingsItemDef) => {
		const Icon = item.icon;
		const value = valueOf(item.id);
		return (
			<ListRow
				key={item.id}
				icon={<Icon {...ICON} />}
				title={<span className="whitespace-nowrap">{item.label}</span>}
				subtitle={subtitleOf(item.id)}
				right={value}
				chevron={item.id !== "thinking"}
				onClick={item.id === "thinking" ? undefined : () => open(item)}
			/>
		);
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-m-bg-elev text-m-text">
			<header
				className={`m-topbar-glass sticky top-0 z-(--z-header) shrink-0 text-m-text transition-[border-color] duration-(--m-dur-fast) ease-m ${
					collapsed ? "" : "border-b-transparent!"
				}`}
				style={{ paddingTop: "var(--m-safe-top)", paddingLeft: "var(--m-safe-left)", paddingRight: "var(--m-safe-right)" }}
			>
				<div className="flex h-13 items-center justify-between gap-2 px-2.5">
					<div className="flex min-w-11 shrink-0 items-center">
						<IconButton variant="plain" icon={<ChevronLeft size={22} strokeWidth={1.75} />} label="返回" onClick={() => nav.back()} />
					</div>
					<div className="pointer-events-none flex min-w-0 flex-1 items-center justify-center">
						<span
							aria-hidden="true"
							className={`truncate text-m-md font-semibold tracking-[-0.01em] text-m-text transition-[opacity,transform,translate] duration-(--m-dur-fast) ease-m motion-reduce:translate-y-0 motion-reduce:transition-opacity ${
								collapsed ? "translate-y-0 opacity-100" : "translate-y-1.5 opacity-0"
							}`}
						>
							设置
						</span>
					</div>
					<div className="min-w-11 shrink-0" aria-hidden="true" />
				</div>
			</header>

			<PullToRefresh ref={scrollerRef} onRefresh={load} className="m-noscrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
				<div
					className="flex flex-col gap-1.5 pb-[calc(var(--m-safe-bottom)+32px)]"
					style={{ paddingLeft: "var(--m-safe-left)", paddingRight: "var(--m-safe-right)" }}
					onClickCapture={(e) => {
						const btn = (e.target as HTMLElement | null)?.closest("button");
						if (btn instanceof HTMLElement) lastClickedRowRef.current = btn;
					}}
				>
					<h1 ref={largeTitleRef} className="px-5 pt-1 pb-2.5 text-[30px] leading-tight font-bold tracking-[-0.025em] text-m-text">设置</h1>

					<ListGroup>{row(QUOTA_ITEM)}</ListGroup>

					{!data && !error && (
						<div className="flex justify-center py-6">
							<Spinner />
						</div>
					)}
					{error && !data && (
						<EmptyState
							title="设置没有加载出来"
							hint={error}
							action={
								<Button variant="tonal" onClick={() => void load()}>
									重试
								</Button>
							}
						/>
					)}

					{SETTINGS_GROUPS.map((group) => (
						<Fragment key={group.id}>
							<ListGroup
								title={group.title}
								className="[&_h3]:pt-4 [&_h3]:pb-1.5 [&_h3]:text-[12px] [&_h3]:font-semibold [&_h3]:uppercase [&_h3]:tracking-[0.04em] [&_h3]:text-m-text-3"
							>
								{group.id === "models" && dirs.length > 0 && (
									<ListRow
										icon={<FolderCog {...ICON} />}
										title="配置范围"
										subtitle="模型角色和备用模型保存到这里"
										right={scopeDir ? <span className="block max-w-full min-w-0 truncate">{dirName(scopeDir)}</span> : "全局"}
										chevron
										onClick={() => {
											setAnchorEl(lastClickedRowRef.current);
											setScopeOpen(true);
										}}
									/>
								)}
								{group.items.map(row)}
							</ListGroup>
							{group.id === "models" && (
								<>
									{data?.ompError && <OmpError omp={data.omp} ompError={data.ompError} />}
									<OmpSettingsGroup keys={["hideThinkingBlock"]} omp={data?.omp} onValue={setOmp} />
								</>
							)}
						</Fragment>
					))}
				</div>
			</PullToRefresh>

			<AnchoredPopover
				open={scopeOpen}
				onClose={() => setScopeOpen(false)}
				anchorEl={anchorEl}
				placement="bottom-end"
				title="配置范围"
				subtitle="选择模型角色和备用模型对谁生效"
				maxWidth={340}
				minWidth={240}
			>
				<div className="py-1.5">
					<MenuRow
						icon={<Globe2 {...ICON} />}
						label="全局配置"
						hint="对所有项目生效"
						selected={cwd == null}
						right={cwd == null ? <Check size={20} className="text-m-accent" /> : undefined}
						onClick={() => chooseScope(null)}
					/>
					{dirs.map((d) => (
						<MenuRow
							key={d.path}
							icon={<FolderCog {...ICON} />}
							label={dirName(d)}
							hint={<span className="break-all">{d.path}</span>}
							selected={cwd === d.path}
							right={cwd === d.path ? <Check size={20} className="text-m-accent" /> : undefined}
							onClick={() => chooseScope(d.path)}
						/>
					))}
				</div>
			</AnchoredPopover>

			{activeSheet === "general" && <GeneralSheet
				open={sheetOpen}
				onClose={close}
				mode={mode}
				defaultModel={data?.defaultModel}
				defaultModelSource={data?.defaultModelSource}
				onModeChange={(m) => setData((d) => (d ? { ...d, defaultApprovalMode: m } : d))}
				automationOverlapPolicy={automationOverlapPolicy}
				onAutomationOverlapPolicyChange={(policy) => setData((d) => (d ? { ...d, automationOverlapPolicy: policy } : d))}
				onOpenAutomations={() => {
					setActiveSheet("automations");
					setSheetOpen(true);
				}}
			/>}
			{activeSheet === "automations" && <AutomationSettingsSheet
				open={sheetOpen}
				onClose={close}
				snapshot={data ? {
					automationBackgroundEnabled: data.automationBackgroundEnabled,
					automationOverlapPolicy: automationOverlapPolicy ?? undefined,
					automationDefaultResultMode: data.automationDefaultResultMode ?? undefined,
					automationDefaultModel: data.automationDefaultModel,
					automationDefaultThinking: data.automationDefaultThinking,
					automationPromptMockTest: data.automationPromptMockTest,
					automationPromptRealOnceTest: data.automationPromptRealOnceTest,
					automationPromptRealLoopTest: data.automationPromptRealLoopTest,
					automationPromptAdjust: data.automationPromptAdjust,
				} : null}
				onUpdate={(next) => setData((d) => (d ? { ...d, ...next } : next))}
			/>}
			{activeSheet === "appearance" && <AppearanceSheet open={sheetOpen} onClose={close} />}
			{activeSheet === "notifications" && <NotifySheet open={sheetOpen} onClose={close} />}
			{activeSheet === "privacy" && <PrivacySheet open={sheetOpen} onClose={close} anchorEl={anchorEl} />}
			{activeSheet === "sessions" && <SessionsSheet open={sheetOpen} onClose={close} omp={data?.omp} ompError={data?.ompError} onOmp={setOmp} />}
			{activeSheet === "doctor" && <DoctorSheet open={sheetOpen} onClose={close} />}
			{activeSheet === "agents-md" && <RulesFilesSheet open={sheetOpen} onClose={close} anchorEl={anchorEl} />}
			{activeSheet === "prompt-composition" && <PromptCompositionSheet open={sheetOpen} onClose={close} />}
			{activeSheet === "tools" && <ToolsSheet open={sheetOpen} onClose={close} omp={data?.omp} ompError={data?.ompError} onOmp={setOmp} />}
			{activeSheet === "subagents" && <SubagentsSheet open={sheetOpen} onClose={close} anchorEl={anchorEl} />}
			{activeSheet === "memory" && <MemorySheet open={sheetOpen} onClose={close} anchorEl={anchorEl} />}
			{activeSheet === "connection" && <ConnectionSheet open={sheetOpen} onClose={close} mobile={data?.mobile} appVersion={data?.appVersion} />}
			{activeSheet === "mcp" && <McpSheet open={sheetOpen} onClose={close} anchorEl={anchorEl} />}
			{activeSheet === "web" && <WebSheet open={sheetOpen} onClose={close} anchorEl={anchorEl} />}
			{activeSheet === "guide" && <GuideSheet open={sheetOpen} onClose={close} />}
			{activeSheet === "about" && <AboutSheet open={sheetOpen} onClose={close} appVersion={data?.appVersion} anchorEl={anchorEl} />}
		</div>
	);
}
