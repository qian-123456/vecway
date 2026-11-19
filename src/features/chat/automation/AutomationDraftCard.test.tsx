// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposer } from "../../../stores/composer";
import { AutomationDraftCard } from "./AutomationDraftCard";
import type { AutomationDraftStatus } from "./automationStatus";

vi.mock("../../../lib/ipc", () => ({
	testScheduleProbe: vi.fn(),
	rpcSend: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../../lib/ensureLive", () => ({
	ensureLive: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
	useComposer.setState({ drafts: {}, focusNonce: {} });
});

afterEach(() => {
	cleanup();
});

const longPrompt =
	"Execute one interaction-only X.com session. ".repeat(35) +
	"Never publish queued main posts.";

describe("AutomationDraftCard", () => {
	it("never dumps long machine prompts on the default card body and prefills chat when refining", () => {
		const status: AutomationDraftStatus = {
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
		};

		render(<AutomationDraftCard sessionId="sess-1" status={status} />);

		expect(screen.getByText(/每分钟执行本地零 LLM 预检/)).toBeTruthy();
		expect(screen.getByText(/已为你生成完整后台执行指令/)).toBeTruthy();
		// Raw prompt text sits only inside the collapsed details element, never in main summary
		expect(screen.queryByText(/Execute one interaction-only/)?.closest("details")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /继续让 AI 调整/ }));
		expect(useComposer.getState().drafts["sess-1"]).toContain("我对「X 自动互动」方案还想调整");
		expect(useComposer.getState().focusNonce["sess-1"]).toBeGreaterThan(0);
	});

	it("renders human-facing summary when provided", () => {
		const status: AutomationDraftStatus = {
			draftId: "draft-2",
			status: "pending",
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
		};

		render(<AutomationDraftCard sessionId="sess-2" status={status} />);

		expect(
			screen.getByText("用浏览器完成一次互动巡检与回复，不发主帖与私信。"),
		).toBeTruthy();
		expect(screen.getByText("Worktree")).toBeTruthy();
	});
});
