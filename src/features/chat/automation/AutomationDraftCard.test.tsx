// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "../../../lib/toast";
import { useComposer } from "../../../stores/composer";
import {
	AutomationDraftCard,
	clearAutomationProbeCacheForTest,
} from "./AutomationDraftCard";
import type { AutomationDraftStatus } from "./automationStatus";

const h = vi.hoisted(() => ({
	testScheduleProbe: vi.fn(),
	rpcSend: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../../lib/ipc", () => ({
	testScheduleProbe: h.testScheduleProbe,
	rpcSend: h.rpcSend,
}));

vi.mock("../../../lib/ensureLive", () => ({
	ensureLive: vi.fn().mockResolvedValue(undefined),
}));

beforeAll(() => {
	class RO {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", RO);
});

beforeEach(() => {
	vi.clearAllMocks();
	clearAutomationProbeCacheForTest();
	useComposer.setState({ drafts: {}, prefillHints: {}, focusNonce: {} });
});

afterEach(() => {
	cleanup();
});

const longPrompt =
	"Execute one interaction-only X.com session. ".repeat(35) +
	"Never publish queued main posts.";

const sampleStatus = (overrides?: Partial<AutomationDraftStatus>): AutomationDraftStatus => ({
	draftId: "draft-1",
	status: "pending",
	draft: {
		id: "sched-1",
		name: "X 自动互动",
		prompt: longPrompt,
		cwd: "/Users/test/X-creator-lab",
		runMode: "local",
		cadence: { kind: "interval", minutes: 30 },
		notify: "important",
		agentTrigger: "on_signal",
		probeCommand: "bash '/tmp/check.sh'",
		probeDescription: "每分钟执行本地零 LLM 预检",
		enabled: true,
	},
	...overrides,
});

describe("AutomationDraftCard", () => {
	it("never dumps long machine prompts on the default card body, avoids text truncation, and prefills chat when refining", () => {
		const { container } = render(
			<AutomationDraftCard sessionId="sess-1" status={sampleStatus()} />,
		);

		const triggerLine = screen.getByText(/每分钟执行本地零 LLM 预检/);
		expect(triggerLine).toBeTruthy();
		expect(triggerLine.className).not.toContain("line-clamp-2");
		expect(screen.getByText(/已为你生成完整后台执行指令/)).toBeTruthy();
		// Raw prompt text sits only inside the collapsed details element, never in main summary
		expect(screen.queryByText(/Execute one interaction-only/)?.closest("details")).toBeTruthy();
		// Carries annotation label so SelectionToolbar tags quotes with the draft name
		expect(
			container.querySelector('[data-annotation-label="自动化草案：X 自动互动"]'),
		).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /继续让 AI 调整/ }));
		expect(useComposer.getState().drafts["sess-1"]).toContain("我对「X 自动互动」方案还想调整");
		expect(useComposer.getState().focusNonce["sess-1"]).toBeGreaterThan(0);
	});

	it("renders human-facing summary when provided", () => {
		const status = sampleStatus({
			draftId: "draft-2",
			summary: "用浏览器完成一次互动巡检与回复，不发主帖与私信。",
			draft: {
				name: "X 自动互动",
				prompt: longPrompt,
				cwd: "/Users/test/X-creator-lab",
				runMode: "worktree",
				cadence: { kind: "interval", minutes: 30 },
				notify: "important",
				agentTrigger: "on_signal",
				probeCommand: "bash '/tmp/check.sh'",
				probeDescription: "仅在活跃时段发出信号",
				enabled: true,
			},
		});

		render(<AutomationDraftCard sessionId="sess-2" status={status} />);

		expect(
			screen.getByText("用浏览器完成一次互动巡检与回复，不发主帖与私信。"),
		).toBeTruthy();
		expect(screen.getByText("Worktree")).toBeTruthy();
	});

	it("prefills composer, sets hint, focuses, and shows toast feedback when selecting a real test run", () => {
		const infoSpy = vi.spyOn(toast, "info").mockImplementation(() => "");
		render(<AutomationDraftCard sessionId="sess-3" status={sampleStatus()} />);

		fireEvent.click(screen.getByRole("button", { name: /测试/ }));
		fireEvent.click(screen.getByRole("button", { name: /真实单次试跑/ }));

		expect(useComposer.getState().drafts["sess-3"]).toContain("真实环境下测试「X 自动互动」");
		expect(useComposer.getState().prefillHints["sess-3"]).toContain("已预填测试说明");
		expect(useComposer.getState().focusNonce["sess-3"]).toBeGreaterThan(0);
		expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("真实单次试跑"));
		infoSpy.mockRestore();
	});

	it("shows clear script-only probe feedback with exit code, hint, toast, and persists across remount", async () => {
		const successSpy = vi.spyOn(toast, "success").mockImplementation(() => "");
		h.testScheduleProbe.mockResolvedValueOnce({
			exitCode: 10,
			timedOut: false,
			durationMs: 42,
			output: "",
			outcome: "quiet",
		});

		const status = sampleStatus({ draftId: "draft-probe" });
		const { unmount } = render(<AutomationDraftCard sessionId="sess-4" status={status} />);

		fireEvent.click(screen.getByRole("button", { name: /测试/ }));
		fireEvent.click(screen.getByRole("button", { name: /仅测脚本/ }));

		await waitFor(() => {
			expect(screen.getByText("无新变化 · 0 消耗")).toBeTruthy();
		});
		expect(screen.getByText("42ms")).toBeTruthy();
		expect(screen.getByText("退出码 10")).toBeTruthy();
		expect(screen.getByText(/静默跳过且不消耗智能体额度/)).toBeTruthy();
		expect(successSpy).toHaveBeenCalledWith(expect.stringContaining("42ms"));

		// Remounting (e.g. closing and reopening the right panel) keeps the cached result
		unmount();
		render(<AutomationDraftCard sessionId="sess-4" status={status} />);
		expect(screen.getByText("无新变化 · 0 消耗")).toBeTruthy();
		expect(screen.getByText("退出码 10")).toBeTruthy();

		// Dismissing clears the result
		fireEvent.click(screen.getByRole("button", { name: "关闭试跑结果" }));
		expect(screen.queryByText("无新变化 · 0 消耗")).toBeNull();
		successSpy.mockRestore();
	});
});
