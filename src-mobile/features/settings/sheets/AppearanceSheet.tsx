import { Check } from "lucide-react";
import { DARK_THEMES, LIGHT_THEMES, resolveThemeId, type MobileThemeDef } from "../../../app/themes";
import { usePrefs } from "../../../core/stores/prefs";
import { ListGroup, Segmented, Switch } from "../../../ui";
import { SettingRow, SettingsSheet } from "../rows";
import { FOLD_OPEN_KEY, MSG_SIZE_KEY, MSG_SIZES, msgSizeFromPref, msgSizePx, SCHEMES } from "../settingsMap";

function ThemeSwatchGrid({
	themes,
	activeId,
	groupLabel,
	onSelect,
}: {
	themes: readonly MobileThemeDef[];
	activeId: string;
	groupLabel: string;
	onSelect: (id: string) => void;
}) {
	return (
		<div role="group" aria-label={groupLabel} className="grid grid-cols-2 gap-2.5">
			{themes.map((theme) => {
				const active = theme.id === activeId;
				const s = theme.swatch;
				return (
					<button
						key={theme.id}
						type="button"
						aria-pressed={active}
						onClick={() => onSelect(theme.id)}
						className={`flex flex-col gap-2 rounded-m-md border p-2 text-left transition-[border-color,box-shadow,transform] duration-(--m-dur-fast) active:scale-[0.98] ${
							active
								? "border-m-accent bg-m-accent-soft/45 ring-1 ring-m-accent/35"
								: "border-m-border bg-m-bg-elev/60 active:bg-m-surface-hover"
						}`}
					>
						{/* Mini chat surface preview */}
						<span
							aria-hidden
							className="flex h-12 w-full flex-col justify-between overflow-hidden rounded-[10px] border border-black/10 p-2"
							style={{ backgroundColor: s.bg }}
						>
							<span className="flex justify-end">
								<span
									className="h-2.5 w-11 rounded-[7px_7px_2px_7px]"
									style={{ backgroundColor: s.bubble }}
								/>
							</span>
							<span className="flex items-center justify-between gap-2">
								<span className="flex flex-1 flex-col gap-1">
									<span className="h-1.5 w-4/5 rounded-full opacity-80" style={{ backgroundColor: s.text }} />
									<span className="h-1.5 w-3/5 rounded-full opacity-35" style={{ backgroundColor: s.text }} />
								</span>
								<span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ backgroundColor: s.accent }} />
							</span>
						</span>
						<span className="flex items-center justify-between gap-1.5 px-0.5">
							<span className="truncate text-m-xs font-medium whitespace-nowrap text-m-text">{theme.name}</span>
							{active ? (
								<span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-m-pill bg-m-accent text-m-accent-text">
									<Check size={11} strokeWidth={2.5} aria-hidden />
								</span>
							) : (
								<span
									aria-hidden
									className="h-3 w-3 shrink-0 rounded-m-pill border border-black/15"
									style={{ backgroundColor: s.accent }}
								/>
							)}
						</span>
					</button>
				);
			})}
		</div>
	);
}

export function AppearanceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
	const scheme = usePrefs((s) => s.scheme);
	const lightTheme = usePrefs((s) => resolveThemeId("light", s.lightTheme));
	const darkTheme = usePrefs((s) => resolveThemeId("dark", s.darkTheme));
	const size = usePrefs((s) => msgSizeFromPref(s.extra[MSG_SIZE_KEY]));
	const foldOpen = usePrefs((s) => s.extra[FOLD_OPEN_KEY] === true);
	const set = usePrefs((s) => s.set);
	const setExtra = usePrefs((s) => s.setExtra);
	const previewSize = { fontSize: `${msgSizePx(size)}px` };

	return (
		<SettingsSheet open={open} onClose={onClose} title="外观设置">
			<ListGroup note="外观只影响这台手机，不会改动电脑上的设置。">
				<SettingRow name="色彩模式" hint="跟随系统，或固定为浅色、深色" stacked>
					<Segmented label="色彩模式" value={scheme} options={SCHEMES} onChange={(v) => set({ scheme: v })} />
				</SettingRow>
				{scheme !== "dark" && (
					<SettingRow
						name={scheme === "system" ? "日间浅色主题" : "浅色主题"}
						hint={scheme === "system" ? "系统为浅色模式时使用的配色" : "点击立即切换浅色配色"}
						stacked
					>
						<ThemeSwatchGrid
							themes={LIGHT_THEMES}
							activeId={lightTheme}
							groupLabel="浅色主题"
							onSelect={(id) => set({ lightTheme: id })}
						/>
					</SettingRow>
				)}
				{scheme !== "light" && (
					<SettingRow
						name={scheme === "system" ? "夜间深色主题" : "深色主题"}
						hint={scheme === "system" ? "系统为深色模式时使用的配色" : "点击立即切换深色配色"}
						stacked
					>
						<ThemeSwatchGrid
							themes={DARK_THEMES}
							activeId={darkTheme}
							groupLabel="深色主题"
							onSelect={(id) => set({ darkTheme: id })}
						/>
					</SettingRow>
				)}
				<SettingRow name="对话字号" hint="对话正文的文字大小" stacked>
					<Segmented label="对话字号" value={size} options={MSG_SIZES} onChange={(v) => setExtra(MSG_SIZE_KEY, v)} />
				</SettingRow>
				<SettingRow name="默认展开步骤" hint="对话里的思考和工具步骤默认展开显示">
					<Switch label="默认展开步骤" checked={foldOpen} onChange={(v) => setExtra(FOLD_OPEN_KEY, v)} />
				</SettingRow>
			</ListGroup>
			<ListGroup title="预览">
				<div aria-label="当前外观预览" className="flex flex-col gap-3 bg-m-bg px-4 py-4">
					<div
						className="self-end rounded-(--m-bubble-radius) border border-m-bubble-user-border bg-m-bubble-user-bg px-4 py-2 text-m-bubble-user-text"
						style={previewSize}
					>
						帮我看看这个报错
					</div>
					<div className="inline-flex w-fit items-center gap-2 rounded-m-md border border-m-border bg-m-bg-elev px-3 py-1.5 text-m-xs text-m-text-2">
						<span aria-hidden className="size-1.5 rounded-full bg-m-success" />
						已运行 2 个步骤 · 3 秒
					</div>
					<div className="leading-[1.6] text-m-text" style={previewSize}>
						好的，我先检查{" "}
						<code className="rounded-[6px] border border-m-border bg-m-surface px-1.5 py-0.5 font-m-mono text-[0.86em]">
							tls.rs
						</code>{" "}
						里的证书指纹校验，再告诉你原因。
					</div>
				</div>
			</ListGroup>
		</SettingsSheet>
	);
}
