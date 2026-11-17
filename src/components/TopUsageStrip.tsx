import { useEffect, useMemo, useRef, useState } from "react";
import { openSettingsTarget } from "../features/settings/settingsTargets";
import type { ActivityUsage } from "../lib/contracts";
import { activityUsage } from "../lib/ipc";
import { useIsDark } from "../lib/theme";
import { useT } from "../stores/language";
import { useSessions } from "../stores/sessions";

const WINDOW_DAYS = 24;

const DARK_RAMP = [
	"var(--track-bg)",
	"#0e4429",
	"#006d32",
	"#26a641",
	"#39d353",
] as const;

const LIGHT_RAMP = [
	"var(--track-bg)",
	"#9be9a8",
	"#40c463",
	"#30a14e",
	"#216e39",
] as const;

function formatCompactTokens(num: number): string {
	if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
	if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
	return String(num);
}

function toDateKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Frameless 30-day token rhythm strip for the home top bar.
 * Clicking opens Settings -> Models & Providers -> Usage & Quota (/usage).
 */
export function TopUsageStrip({ hasRightBadge = false }: { hasRightBadge?: boolean } = {}) {
	const { t } = useT();
	const isDark = useIsDark();
	const ramp = isDark ? DARK_RAMP : LIGHT_RAMP;
	const sessions = useSessions((s) => s.sessions);
	const [usage, setUsage] = useState<ActivityUsage | null>(null);
	const refreshRef = useRef<() => void>(() => {});
	const didInitRef = useRef(false);

	useEffect(() => {
		let mounted = true;
		let inFlight = false;
		const refresh = () => {
			if (inFlight) return;
			inFlight = true;
			void activityUsage()
				.then((res) => {
					if (mounted && res) setUsage(res);
				})
				.catch(() => {})
				.finally(() => {
					inFlight = false;
				});
		};
		refreshRef.current = refresh;
		const timer = window.setInterval(refresh, 60_000);
		return () => {
			mounted = false;
			refreshRef.current = () => {};
			window.clearInterval(timer);
		};
	}, []);

	useEffect(() => {
		const anyWorking = Object.values(sessions).some((s) => s.status === "working");
		if (didInitRef.current && anyWorking) return;
		didInitRef.current = true;
		refreshRef.current();
	}, [sessions]);

	const summary = useMemo(() => {
		if (!usage) return null;
		const now = new Date();
		now.setHours(0, 0, 0, 0);
		const byDate = new Map((usage.days ?? []).map((d) => [d.date, d]));

		let totalTokens = 0;
		let knownDays = 0;
		let missingRequests = 0;
		for (let offset = 29; offset >= 0; offset--) {
			const cur = new Date(now);
			cur.setDate(now.getDate() - offset);
			const entry = byDate.get(toDateKey(cur));
			if (!entry) continue;
			if (entry.tokens !== null) {
				totalTokens += entry.tokens;
				knownDays += 1;
			}
			missingRequests += entry.missingRequests;
		}

		let peak = 0;
		const rawWindow: Array<{ key: string; tokens: number | null; active: boolean }> = [];
		for (let offset = WINDOW_DAYS - 1; offset >= 0; offset--) {
			const cur = new Date(now);
			cur.setDate(now.getDate() - offset);
			const key = toDateKey(cur);
			const entry = byDate.get(key);
			if (entry?.tokens != null) peak = Math.max(peak, entry.tokens);
			rawWindow.push({
				key,
				tokens: entry ? entry.tokens : 0,
				active: Boolean(entry && (entry.tokens === null || entry.tokens > 0)),
			});
		}

		const bars = rawWindow.map((item) => {
			if (!item.active || item.tokens === 0) return { key: item.key, level: 0 as const };
			if (item.tokens === null || peak <= 0) return { key: item.key, level: 1 as const };
			const ratio = item.tokens / peak;
			const level: 1 | 2 | 3 | 4 =
				ratio <= 0.25 ? 1 : ratio <= 0.5 ? 2 : ratio <= 0.75 ? 3 : 4;
			return { key: item.key, level };
		});

		const unknownOnly = knownDays === 0 && missingRequests > 0;
		const formattedTotal = unknownOnly
			? t("topbar.recent30dUnknown")
			: `${missingRequests > 0 ? "≥" : ""}${formatCompactTokens(totalTokens)}`;

		return { formattedTotal, bars };
	}, [usage, t]);

	if (!summary) return null;

	return (
		<button
			type="button"
			onClick={() => openSettingsTarget("quota")}
			title={t("topbar.openUsageTip")}
			className="group inline-flex min-w-0 shrink items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 -mx-1 text-[11.5px] text-[var(--text-muted)] tabular-nums transition-colors hover:bg-[var(--ghost-hover,var(--bg-hover))] hover:text-[var(--text)] active:opacity-80 cursor-pointer"
		>
			<span className="shrink-0 whitespace-nowrap">
				{t("topbar.recent30dPrefix")}{" "}
				<strong className="font-mono font-semibold text-[var(--text)]">
					{summary.formattedTotal}
				</strong>{" "}
				tokens
			</span>
			<span
				className={`hidden shrink-0 items-center gap-[2px] ${hasRightBadge ? "@[580px]:inline-flex" : "@[490px]:inline-flex"}`}
				aria-hidden="true"
			>
				{summary.bars.map((bar) => (
					<span
						key={bar.key}
						className="inline-block h-[9px] w-[4px] rounded-[1.5px]"
						style={{ backgroundColor: ramp[bar.level] }}
					/>
				))}
			</span>
		</button>
	);
}
