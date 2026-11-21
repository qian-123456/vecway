// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResultInfo } from "../../../lib/contracts";
import { formatWithAnnotations, useComposer } from "../../../stores/composer";
import { emptySessionLive, useLive } from "../../../stores/live";
import { useUi } from "../../../stores/ui";
import type { TurnStep } from "../turnGrouping";
import { AutomationDraftsPanel } from "./AutomationDraftsPanel";
import { AutomationTurnCard, extractTurnProposedDrafts } from "./AutomationTurnCard";
import { clearLatestDraftFocus } from "./automationDraftFocus";
import type { AutomationDraftStatus, AutomationSessionState } from "./automationStatus";
import { useAutomationPanelLifecycle } from "./useAutomationPanelLifecycle";

vi.mock("../../../lib/ipc", () => ({
	testScheduleProbe: vi.fn(),
	rpcSend: vi.fn().mockResolvedValue({}),
	saveClipboardImage: vi.fn(async () => "/tmp/a.png"),
	importImageFile: vi.fn(async (p: string) => p),
	clipboardFilePaths: vi.fn(async () => []),
}));

vi.mock("../../../lib/ensureLive", () => ({
	ensureLive: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

beforeAll(() => {
	class RO {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", RO);
	if (typeof Range.prototype.getBoundingClientRect !== "function") {
		Range.prototype.getBoundingClientRect = () => new DOMRect(10, 10, 40, 16);
	}
	if (typeof Range.prototype.getClientRects !== "function") {
		Range.prototype.getClientRects = () => [new DOMRect(10, 10, 40, 16)] as unknown as DOMRectList;
	}
	if (typeof HTMLElement.prototype.scrollIntoView !== "function") {
		HTMLElement.prototype.scrollIntoView = vi.fn();
	}
});

const makeDraft = (id: string, name: string, summary: string, status: "pending" | "saved" = "pending"): AutomationDraftStatus => ({
	draftId: id,
	status,
	summary,
	draft: {
		name,
		prompt: "Run the workflow safely",
		cwd: "/Users/test/X-creator-lab",
		runMode: "local",
		cadence: { kind: "interval", minutes: 30 },
		notify: "important",
		agentTrigger: "on_signal",
		probeCommand: "node check.mjs",
		probeDescription: `预检 ${name}`,
		enabled: true,
	},
});

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	clearLatestDraftFocus();
	useComposer.setState({ annotations: {}, drafts: {}, prefillHints: {}, focusNonce: {} });
	useLive.setState({ sessions: {} });
	useUi.setState({
		selectedSessionId: "sess-1",
		rightOpen: true,
		rightTab: "automation",
		openRightTabs: ["automation"],
	});
});

afterEach(() => {
	cleanup();
});

describe("AutomationDraftsPanel", () => {
	it("renders all session drafts in a scrollable panel and supports text selection annotation with draft label", () => {
		const drafts = [
			makeDraft("draft-a", "X 日常巡航", "空闲时自动消化收件箱并执行蓝 V 互动。"),
			makeDraft("draft-b", "X 快速自迭代复盘", "每 4 小时零 Token 探测触发信号并刷新战术记忆。"),
		];
		useLive.setState({
			sessions: {
				"sess-1": {
					...emptySessionLive(),
					streaming: true,
					automationState: { mode: "active", drafts },
				},
			},
		});

		const { container } = render(<AutomationDraftsPanel />);
		expect(screen.getByText("2 项待确认")).toBeTruthy();
		expect(screen.getByText("正在主对话中执行")).toBeTruthy();
		expect(screen.getByText("X 日常巡航")).toBeTruthy();
		expect(screen.getByText("X 快速自迭代复盘")).toBeTruthy();

		// Select text inside the second draft card summary and annotate it into the main composer
		const scrollContainer = container.querySelector("[data-automation-drafts-scroll]") as HTMLElement;
		const summaryEl = screen.getByText(/每 4 小时零 Token 探测触发信号/);
		const textNode = Array.from(summaryEl.childNodes).find(
			(n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").includes("探测触发信号"),
		)!;
		fireEvent.mouseDown(summaryEl);
		const range = document.createRange();
		const text = textNode.textContent ?? "";
		const start = text.indexOf("探测触发信号");
		range.setStart(textNode, start);
		range.setEnd(textNode, start + "探测触发信号".length);
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		sel.addRange(range);
		fireEvent.mouseUp(scrollContainer);

		fireEvent.click(screen.getByRole("button", { name: "批注" }));
		const commentBox = screen.getByRole("textbox", { name: "添加批注" });
		fireEvent.change(commentBox, { target: { value: "改成每 6 小时" } });
		fireEvent.click(screen.getByRole("button", { name: "确认批注" }));

		const anns = useComposer.getState().annotations["sess-1"];
		expect(anns).toHaveLength(1);
		expect(anns[0].text).toBe("探测触发信号");
		expect(anns[0].label).toBe("自动化草案：X 快速自迭代复盘");
		expect(formatWithAnnotations("请按批注调整", anns)).toContain(
			"[1] (自动化草案：X 快速自迭代复盘)",
		);
	});
});

describe("AutomationTurnCard", () => {
	it("extracts proposed drafts from turn tool steps, reflects live statuses, and opens right panel on click", () => {
		const steps = [
			{
				id: "s-1",
				kind: "tool",
				item: {} as never,
				call: {
					id: "call-1",
					name: "vecway_automation",
					args: {
						action: "propose",
						draft: {
							name: "X 日常巡航",
							cadence: { kind: "interval", minutes: 30 },
						},
					},
				},
			},
			{
				id: "s-2",
				kind: "tool",
				item: {} as never,
				call: {
					id: "call-2",
					name: "vecway_automation",
					args: {
						action: "propose",
						draft: {
							name: "X 周度巡检",
							cadence: { kind: "daily", time: "21:23" },
						},
					},
				},
			},
		] as unknown as TurnStep[];

		const results = new Map<string, ToolResultInfo>([
			[
				"call-1",
				{
					toolCallId: "call-1",
					toolName: "vecway_automation",
					text: 'Staged Automation Draft Card (draft-101) for "X 日常巡航".',
					isError: false,
					details: { draftId: "draft-101" },
				},
			],
			[
				"call-2",
				{
					toolCallId: "call-2",
					toolName: "vecway_automation",
					text: 'Staged Automation Draft Card (draft-102) for "X 周度巡检".',
					isError: false,
					details: { draftId: "draft-102" },
				},
			],
		]);

		expect(extractTurnProposedDrafts(steps, results)).toHaveLength(2);

		useUi.setState({
			selectedSessionId: "sess-1",
			rightOpen: false,
			rightTab: "explorer",
			openRightTabs: ["explorer"],
		});
		useLive.setState({
			sessions: {
				"sess-1": {
					...emptySessionLive(),
					automationState: {
						mode: "active",
						drafts: [
							makeDraft("draft-101", "X 日常巡航", "摘要 A", "saved"),
							makeDraft("draft-102", "X 周度巡检", "摘要 B", "pending"),
						],
					},
				},
			},
		});

		render(
			<AutomationTurnCard
				sessionId="sess-1"
				steps={steps}
				toolResultsByCallId={results}
			/>,
		);

		expect(screen.getByText("已生成 2 项自动化草案")).toBeTruthy();
		expect(screen.getByText("1 项待确认")).toBeTruthy();
		expect(screen.getByText("1 项已启用")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /X 周度巡检/ }));
		expect(useUi.getState().rightTab).toBe("automation");
		expect(useUi.getState().rightOpen).toBe(true);
	});
});

describe("useAutomationPanelLifecycle", () => {
	function LifecycleHost({
		sessionId,
		state,
	}: {
		sessionId: string;
		state: AutomationSessionState | undefined;
	}) {
		useAutomationPanelLifecycle(sessionId, state);
		return null;
	}

	it("auto-opens automation tab only when a new pending draft arrives and respects manual close", () => {
		useUi.setState({
			selectedSessionId: "sess-1",
			rightOpen: true,
			rightTab: "explorer",
			openRightTabs: ["explorer"],
		});

		// Initial hydration with an existing pending draft does not hijack the user's current right tab
		const initial: AutomationSessionState = {
			mode: "active",
			drafts: [makeDraft("draft-old", "旧草案", "summary")],
		};
		const { rerender } = render(<LifecycleHost sessionId="sess-1" state={initial} />);
		expect(useUi.getState().rightTab).toBe("explorer");

		// A new draft arrives -> automatically opens the right automation panel
		const withNew: AutomationSessionState = {
			mode: "active",
			drafts: [
				makeDraft("draft-old", "旧草案", "summary"),
				makeDraft("draft-new", "新草案", "summary"),
			],
		};
		rerender(<LifecycleHost sessionId="sess-1" state={withNew} />);
		expect(useUi.getState().rightTab).toBe("automation");

		// User manually switches away -> re-rendering same drafts stays on explorer
		act(() => useUi.getState().setRightTab("explorer"));
		rerender(<LifecycleHost sessionId="sess-1" state={{ ...withNew }} />);
		expect(useUi.getState().rightTab).toBe("explorer");
	});
});
