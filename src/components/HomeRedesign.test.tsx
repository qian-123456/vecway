// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "../lib/ipc";

const openSettingsTarget = vi.hoisted(() => vi.fn());

vi.mock("../features/settings/settingsTargets", () => ({
	openSettingsTarget,
}));

vi.mock("../lib/ipc", async (importOriginal) => {
	const orig = await importOriginal<typeof IpcModule>();
	return {
		...orig,
		activityUsage: vi.fn(async () => ({
			days: [
				{
					date: new Date().toISOString().slice(0, 10),
					tokens: 4_800_000_000,
					missingRequests: 0,
					sessions: 5,
					turns: 20,
					topModel: "claude-sonnet-4-6",
				},
			],
		})),
		gitBadge: vi.fn(async () => ({ branch: "main", dirty: 6 })),
		getAppMemoryUsage: vi.fn(async () => ({ formatted: "512 MB", processes: 4, bytes: 536870912 })),
		perfBreakdown: vi.fn(async () => null),
	};
});

import { BottomBar } from "./BottomBar";
import { HomeRecentSessions, StartHero } from "./StartHero";
import { TopUsageStrip } from "./TopUsageStrip";
import { VecwayWordmark } from "./VecwayWordmark";
import { usePendingSession } from "../features/sessions/pendingSession";
import { useSidebarStore } from "../features/sessions/sidebarStore";
import { useLanguageStore } from "../stores/language";
import { useLive } from "../stores/live";
import { useSessions } from "../stores/sessions";
import { useUi } from "../stores/ui";

describe("Home & shell redesign components", () => {
	beforeEach(() => {
		localStorage.clear();
		openSettingsTarget.mockClear();
		useLanguageStore.getState().setLocale("zh-CN");
		useSidebarStore.setState({ activeMode: "code" });
		useSessions.setState({
			workspaces: [
				{
					id: "ws-1",
					path: "/Users/test/omp-workspace",
					name: "omp-workspace",
					kind: "project",
					mode: "code",
					sort: 0,
				},
			],
			sessions: {
				"prev-1": {
					id: "prev-1",
					mode: "code",
					cwd: "/Users/test/omp-workspace",
					file: "/tmp/prev-1.jsonl",
					title: "优化 add provider 页面 UI",
					label: "",
					status: "idle",
					updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
					createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
					workspaceId: "ws-1",
					lastAssistant: "done",
					live: false,
					git: { branch: "main", dirty: 6 },
				} as never,
			},
			hasLoaded: true,
			loadError: null,
		});
		usePendingSession.setState({
			drafts: {
				"local-draft:1": {
					id: "local-draft:1",
					cwd: "/Users/test/omp-workspace",
					mode: "code",
					groupId: null,
					opts: { cwd: "/Users/test/omp-workspace" } as never,
					model: null,
					thinking: null,
					sessionId: null,
					startError: null,
				},
			},
			selectedId: "local-draft:1",
		});
		useLive.setState({ sessions: {} });
		useUi.setState({
			selectedSessionId: null,
			lastSessionId: "prev-1",
			centerView: "session",
		});
	});

	afterEach(() => {
		cleanup();
	});

	it("renders VecwayWordmark with accessible Vecway label and cutout mask", () => {
		const { container } = render(<VecwayWordmark />);
		expect(screen.getByRole("img", { name: "Vecway" })).toBeTruthy();
		expect(container.querySelector("mask circle")).not.toBeNull();
		expect(container.querySelector("text")?.textContent).toBe("ecway");
	});

	it("renders TopUsageStrip with 30-day token total and opens quota settings on click", async () => {
		render(<TopUsageStrip />);
		const btn = await screen.findByRole("button");
		expect(btn.textContent).toContain("近 30 天");
		expect(btn.textContent).toContain("4.8B");
		expect(btn.textContent).toContain("tokens");
		fireEvent.click(btn);
		expect(openSettingsTarget).toHaveBeenCalledWith("quota");
	});

	it("renders StartHero folder icon, clickable project name, live subtitle, and recent continuation row", async () => {
		render(
			<>
				<StartHero sessionId="local-draft:1" />
				<HomeRecentSessions sessionId="local-draft:1" />
			</>,
		);
		expect(screen.getByText("在")).toBeTruthy();
		expect(screen.getByText("omp-workspace")).toBeTruthy();
		expect(screen.getByText("开始新任务")).toBeTruthy();
		await waitFor(() => {
			expect(screen.getByText(/main 分支 · 6 处未提交改动 · 上次对话于/)).toBeTruthy();
		});
		const recentBtn = screen.getByRole("button", { name: /优化 add provider 页面 UI/ });
		fireEvent.click(recentBtn);
		expect(useUi.getState().selectedSessionId).toBe("prev-1");
	});

	it("keeps BottomBar quiet on home/draft and shows DSH telemetry only for an active selected session", async () => {
		useLive.setState({
			sessions: {
				"prev-1": {
					alive: false,
					streaming: false,
					items: [
						{ id: "u1", kind: "user", ts: "2026-11-17T08:00:00Z", text: "hi" },
						{
							id: "a1",
							kind: "assistant",
							ts: "2026-11-17T08:00:05Z",
							text: "hello",
							usage: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0, totalTokens: 3500 },
						},
					],
					state: { contextUsage: { percent: 18.4 } },
				} as never,
			},
		});

		const { rerender } = render(<BottomBar />);
		expect(screen.queryByText(/工作台已就绪/)).toBeNull();
		expect(screen.queryByText(/omp /)).toBeNull();
		expect(screen.queryByText(/100%/)).toBeNull();
		// Even though lastSessionId ("prev-1") has data, selectedSessionId is null so telemetry stays hidden:
		expect(screen.queryByText(/1 轮 1 步/)).toBeNull();

		act(() => {
			useUi.setState({ selectedSessionId: "prev-1" });
		});
		rerender(<BottomBar />);
		expect(await screen.findByText("上下文 18%")).toBeTruthy();
		expect(screen.getByText("1 轮 1 步")).toBeTruthy();
	});
});
