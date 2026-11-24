// @vitest-environment jsdom
import { act, cleanup, fireEvent, isInaccessible, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "../lib/ipc";
import type * as StatsModule from "../features/chat/sessionStats";
import { getAppMemoryUsage, perfBreakdown } from "../lib/ipc";

const H = vi.hoisted(() => ({
	stats: {
		rounds: 1, steps: 2, totalTokens: 3500, inputTokens: 1000, outputTokens: 500,
		cacheRead: 2000, cacheWrite: 0, cacheHitRate: 66.7, modelDurationMs: 10000,
		toolDurationMs: 0, avgTtftMs: 100, tps: 50, timedRequests: 1, hasData: true,
	} as StatsModule.ComputedSessionStats,
}));
vi.mock("../lib/zoom", () => ({ useZoom: () => {} }));
vi.mock("../lib/ipc", async (importOriginal) => ({
	...await importOriginal<typeof IpcModule>(),
	getAppMemoryUsage: vi.fn(async () => ({ formatted: "512 MB", processes: 4, bytes: 536870912 })),
	perfBreakdown: vi.fn(async () => null),
}));
vi.mock("../features/chat/sessionStats", async (importOriginal) => ({
	...await importOriginal<typeof StatsModule>(),
	computeSessionStats: () => H.stats,
}));

import { BottomBar } from "./BottomBar";
import { useChatUi } from "../features/chat/chatUi";
import { usePendingSession } from "../features/sessions/pendingSession";
import { useDisplayPrefs } from "../stores/displayPrefs";
import { useLanguageStore } from "../stores/language";
import { useLive } from "../stores/live";
import { useSessions } from "../stores/sessions";
import { useUi } from "../stores/ui";

let barWidth = 630;
let widths: Record<string, number>;
const observers = new Set<{ callback: ResizeObserverCallback; targets: Set<Element> }>();

// jsdom has no layout engine. Supply only intrinsic browser measurements: the
// component still chooses what to collapse, renders it and opens real details.
function occupiedWidth(bar: Element) {
	const stats = bar.querySelector<HTMLElement>("[data-bottom-bar-stats]");
	const right = bar.querySelector<HTMLElement>("[data-bottom-bar-right]")!;
	return right.getBoundingClientRect().width + 8 + (stats ? stats.getBoundingClientRect().width - 6 : 0);
}

function resize(target?: Element) {
	act(() => {
		for (const observer of [...observers]) {
			if (!target || observer.targets.has(target)) observer.callback([], {} as ResizeObserver);
		}
	});
}

function expectVisible(text: string, visible = true) {
	expect(isInaccessible(screen.getByText(text))).toBe(!visible);
}

beforeEach(() => {
	barWidth = 630;
	widths = { context: 40, rounds: 50, tps: 60, tokens: 70, cache: 80, memory: 80, branch: 90 };
	H.stats.totalTokens = 3500;
	H.stats.cacheHitRate = 66.7;
	H.stats.tps = 50;
	useLanguageStore.getState().setLocale("zh-CN");
	useDisplayPrefs.setState({ bottomBar: true });
	useChatUi.setState({ statsOpen: false });
	useUi.setState({ selectedSessionId: "fit", rightOpen: false, rightTab: "git" });
	usePendingSession.setState({ selectedId: null });
	useSessions.setState({ sessions: {
		fit: { id: "fit", git: { branch: "main", dirty: 6 } } as never,
	} });
	useLive.setState({ sessions: {
		fit: { items: [], streaming: false, state: { contextUsage: { percent: 18 } } } as never,
	} });
	vi.stubGlobal("ResizeObserver", class {
		entry: { callback: ResizeObserverCallback; targets: Set<Element> };
		constructor(callback: ResizeObserverCallback) {
			this.entry = { callback, targets: new Set() };
			observers.add(this.entry);
		}
		observe(element: Element) { this.entry.targets.add(element); }
		unobserve(element: Element) { this.entry.targets.delete(element); }
		disconnect() { observers.delete(this.entry); }
	});
	const computedStyle = window.getComputedStyle.bind(window);
	vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
		const bar = element.hasAttribute("data-app-bottombar");
		const stats = element.hasAttribute("data-bottom-bar-stats");
		const right = element.hasAttribute("data-bottom-bar-right");
		const overrides: Record<string, string> = {
			columnGap: `${bar || right ? 8 : stats ? 6 : 4}px`,
			paddingLeft: bar ? "14px" : "0px", paddingRight: bar ? "14px" : "0px",
			marginLeft: stats ? "-6px" : "0px", marginRight: "0px",
		};
		return new Proxy(computedStyle(element), {
			get(target, property) {
				if (typeof property === "string" && property in overrides) return overrides[property];
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	});
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
		const element = this as HTMLElement;
		if (element.hasAttribute("data-app-bottombar")) return new DOMRect(0, 0, barWidth, 24);
		const part = element.dataset.bottomBarPart;
		if (part) return new DOMRect(0, 0, widths[part], 14);
		const stats = element.hasAttribute("data-bottom-bar-stats");
		const right = element.hasAttribute("data-bottom-bar-right");
		if (stats || right) {
			let width = stats ? 23.5 : useSessions.getState().sessions.fit.git?.branch ? 60 : 23;
			for (const item of element.querySelectorAll<HTMLElement>("[data-bottom-bar-part]")) {
				if (item.dataset.collapsed !== "true") width += widths[item.dataset.bottomBarPart!] + (stats ? 6 : 4);
			}
			return new DOMRect(0, 0, width, 20);
		}
		return new DOMRect(0, 0, 20, 20);
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	observers.clear();
});

describe("BottomBar content fitting", () => {
	it("does not sample the hidden bar and uses the panel's sample for the visible memory badge", async () => {
		useDisplayPrefs.setState({ bottomBar: false });
		vi.mocked(getAppMemoryUsage).mockClear();
		vi.mocked(perfBreakdown).mockResolvedValueOnce({
			app: { bytes: 1536 * 1024 * 1024, processes: 7 },
			ompSpawned: { bytes: 0, processes: 0 }, ompExternal: { bytes: 0, processes: 0 },
			totalBytes: null, usedBytes: null, freeBytes: null, otherBytes: null,
			barOmpBytes: 0, instances: [], generatedAt: 1,
		});
		render(<BottomBar />);
		expect(getAppMemoryUsage).not.toHaveBeenCalled();
		await act(async () => { useDisplayPrefs.setState({ bottomBar: true }); });
		const button = screen.getByRole("button", { name: "性能 512 MB" });
		await act(async () => { fireEvent.click(button); });
		expect(button.getAttribute("aria-label")).toBe("性能 1.5 GB");
		expect(getAppMemoryUsage).toHaveBeenCalledTimes(1);
	});

	it("shows every metric below the old 640px breakpoint when the actual content fits", () => {
		render(<BottomBar />);
		expectVisible("3.5k tok");
		expectVisible("50.0 tok/s");
		expectVisible("缓存 66.7%");
		expectVisible("main");
	});

	it("collapses one part at the exact boundary and restores it without resize hysteresis", () => {
		const { container } = render(<BottomBar />);
		const bar = container.querySelector("footer")!;
		// All content occupies 593.5px; the footer has 28px horizontal padding.
		barWidth = 621.5;
		resize();
		expectVisible("缓存 66.7%");
		barWidth -= 0.25;
		resize();
		expectVisible("缓存 66.7%", false);
		expectVisible("50.0 tok/s");
		expect(occupiedWidth(bar)).toBeLessThanOrEqual(barWidth - 28);
		barWidth = 621.5;
		resize();
		expectVisible("缓存 66.7%");
	});

	it("uses actual content width even above every old breakpoint, with details still reachable", () => {
		barWidth = 1200;
		for (const id of Object.keys(widths)) widths[id] *= 3;
		const { container } = render(<BottomBar />);
		expectVisible("缓存 66.7%", false);
		expectVisible("50.0 tok/s", false);
		expectVisible("3.5k tok");
		expect(occupiedWidth(container.querySelector("footer")!)).toBeLessThanOrEqual(barWidth - 28);
		fireEvent.click(screen.getByRole("button", { name: /会话统计/ }));
		expect(useChatUi.getState().statsOpen).toBe(true);
		expect(screen.getByRole("button", { name: /会话统计/ }).getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: /查看 Git 面板/ }));
		expect(useUi.getState().rightOpen).toBe(true);
	});

	it("recomputes for changed data, branch width and font metrics without resizing the window", () => {
		const { rerender } = render(<BottomBar />);
		widths.tokens += 50;
		H.stats.totalTokens = 3_500_000;
		act(() => useLive.setState({ sessions: {
			fit: { ...useLive.getState().sessions.fit, items: [] },
		} }));
		expectVisible("3.5M tok");
		expectVisible("缓存 66.7%", false);
		widths.tokens -= 50;
		resize(); // Intrinsic text resize (e.g. a font finishing loading).
		expectVisible("缓存 66.7%");
		widths.branch += 50;
		act(() => useSessions.setState({ sessions: {
			fit: { ...useSessions.getState().sessions.fit, git: { branch: "feature/long-name", dirty: 999, worktree: null } },
		} }));
		expectVisible("缓存 66.7%", false);
		widths.branch -= 50;
		rerender(<BottomBar />);
		expectVisible("缓存 66.7%");
	});

	it("restores after hiding/showing and adds/removes optional metrics without stale measurements", () => {
		render(<BottomBar />);
		act(() => useDisplayPrefs.setState({ bottomBar: false }));
		barWidth = 550;
		act(() => useDisplayPrefs.setState({ bottomBar: true }));
		expectVisible("缓存 66.7%", false);
		act(() => useUi.setState({ selectedSessionId: null }));
		expect(screen.queryByText("缓存 66.7%")).toBeNull();
		barWidth = 630;
		act(() => useUi.setState({ selectedSessionId: "fit" }));
		expectVisible("缓存 66.7%");
		expect(observers.size).toBe(1);
	});

	it("restores metrics when optional data disappears and keeps measuring newly added fields", () => {
		barWidth = 550;
		const { rerender } = render(<BottomBar />);
		expectVisible("缓存 66.7%", false);
		H.stats.tps = null;
		H.stats.cacheHitRate = null;
		rerender(<BottomBar />);
		expect(screen.queryByText("50.0 tok/s")).toBeNull();
		expect(screen.queryByText("缓存 66.7%")).toBeNull();
		expectVisible("3.5k tok");
		H.stats.tps = 50;
		H.stats.cacheHitRate = 66.7;
		rerender(<BottomBar />);
		expectVisible("缓存 66.7%", false);
		barWidth = 630;
		resize();
		expectVisible("缓存 66.7%");
		expectVisible("50.0 tok/s");
	});

	it("keeps icon-only controls reachable when every optional label must collapse", () => {
		barWidth = 150;
		const { container } = render(<BottomBar />);
		for (const label of ["上下文 18%", "1 轮 2 步", "3.5k tok", "50.0 tok/s", "缓存 66.7%", "main"]) {
			expectVisible(label, false);
		}
		expect(occupiedWidth(container.querySelector("footer")!)).toBeLessThanOrEqual(barWidth - 28);
		const performance = screen.getByRole("button", { name: /^性能 / });
		fireEvent.click(performance);
		expect(performance.getAttribute("aria-expanded")).toBe("true");
	});

	it("observes intrinsic width changes even for currently collapsed fields", () => {
		widths.cache += 50;
		render(<BottomBar />);
		expectVisible("缓存 66.7%", false);
		const cache = screen.getByText("缓存 66.7%").closest("[data-bottom-bar-part]")!;
		widths.cache -= 50;
		resize(cache);
		expectVisible("缓存 66.7%");
	});
});
