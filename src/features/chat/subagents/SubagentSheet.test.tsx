// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const subagentTranscript = vi.fn();
vi.mock("../../../lib/ipc", async (orig) => ({
	...(await orig<object>()),
	subagentTranscript: (...a: unknown[]) => subagentTranscript(...a),
}));

import { SubagentSheet } from "./SubagentSheet";
import type { AgentRow } from "./merge";

const row = (id: string): AgentRow =>
	({
		id,
		status: "completed",
		label: id,
		filePath: `/s/parent/${id}.jsonl`,
	}) as unknown as AgentRow;

const transcript = (output: string) => ({
	systemPrompt: null,
	prompt: "p",
	output,
	outputPath: null,
	items: [],
	nextByte: 1,
	reset: false,
});

afterEach(cleanup);

describe("SubagentSheet", () => {
	it("shows real per-request statistics in the process pane", async () => {
		subagentTranscript.mockResolvedValueOnce({
			...transcript(""),
			items: [{
				id: "request", kind: "assistant", ts: "2026-10-26T22:16:54.000Z",
				text: "answer", toolCalls: [], stopReason: "stop", duration: 4000, ttft: 1000,
				usage: { input: 1200, output: 400, cacheRead: 2400, cacheWrite: 0, totalTokens: 4000, cost: 0 },
			}],
		});
		render(<SubagentSheet parentFile="/s/parent.jsonl" row={row("stats")} onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "过程" }));
		expect(await screen.findByText(/↘1.2K/)).toBeTruthy();
		expect(screen.getByText(/↗400/)).toBeTruthy();
		expect(screen.getByText(/💾2.4K/)).toBeTruthy();
		expect(screen.getByText(/⏱1.0s/)).toBeTruthy();
		expect(screen.getByText(/⚡100.0\/s/)).toBeTruthy();
	});

	it("shows known zero output and missing partial usage independently", async () => {
		subagentTranscript.mockResolvedValueOnce({
			...transcript(""),
			items: [{
				id: "partial", kind: "assistant", ts: "2026-10-26T22:16:54.000Z",
				text: "partial", toolCalls: [], stopReason: "stop", duration: 1000, ttft: null,
				usage: { input: null, output: 0, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null },
			}],
		});
		render(<SubagentSheet parentFile="/s/parent.jsonl" row={row("partial")} onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "过程" }));
		expect(await screen.findByText("↗0")).toBeTruthy();
		expect(screen.getByText("↘—")).toBeTruthy();
		expect(screen.getByText("💾—")).toBeTruthy();
		expect(screen.getByText("⚡0.0/s")).toBeTruthy();
	});

	it("drops the previous subagent's output when stepping to one that fails to load", async () => {
		subagentTranscript.mockResolvedValueOnce(transcript("OUTPUT-A"));
		const props = { parentFile: "/s/parent.jsonl", onClose: () => {} };
		const { rerender } = render(<SubagentSheet {...props} row={row("a")} />);
		fireEvent.click(screen.getByRole("button", { name: "输出" }));
		expect(await screen.findByText(/OUTPUT-A/)).toBeTruthy();

		subagentTranscript.mockRejectedValueOnce(new Error("no file yet"));
		rerender(<SubagentSheet {...props} row={row("b")} />);
		fireEvent.click(screen.getByRole("button", { name: "过程" }));
		expect(await screen.findByText(/no file yet/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "输出" }));
		expect(screen.queryByText(/OUTPUT-A/)).toBeNull();
	});

	it("updates stale running row to completed using transcript summary, showing duration and completion time", async () => {
		const runningRow = {
			...row("ios-draft"),
			status: "running" as const,
			durationMs: 22000, // Stale 22s
			cost: 0, // Zero cost placeholder
		};
		subagentTranscript.mockResolvedValueOnce({
			...transcript("DONE"),
			summary: {
				id: "ios-draft",
				status: "completed",
				startedAt: "2026-10-26T22:15:34.000Z",
				endedAt: "2026-10-26T22:16:54.000Z", // 80s later
				toolCallCount: 42,
				requestCount: 5,
				tokens: 252000,
				cost: 0.045,
				filePath: "/s/parent/ios-draft.jsonl",
			},
		});
		render(<SubagentSheet parentFile="/s/parent.jsonl" row={runningRow} onClose={() => {}} />);

		// Should reflect completed status and 80s (1分20秒) in header chip and overview card
		const durationEls = await screen.findAllByText(/1分20秒/);
		expect(durationEls.length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText(/已完成/).length).toBeGreaterThanOrEqual(1);
		expect(screen.queryByText(/22秒/)).toBeNull();
		// Should show timing card and "工具调用" label in execution stats card
		expect(screen.getByText("运行时间")).toBeTruthy();
		expect(screen.getByText("工具调用")).toBeTruthy();
		expect(screen.getByText("42")).toBeTruthy();
		// Should show non-zero cost formatted, not $0.00
		expect(screen.getByText("$0.045")).toBeTruthy();
	});

	it("shows a recorded zero cost without inventing a duration", async () => {
		const pendingRow = {
			...row("zero-cost"),
			status: "pending" as const,
			durationMs: 0,
			cost: 0,
		};
		subagentTranscript.mockResolvedValueOnce({
			...transcript(""),
			summary: {
				id: "zero-cost",
				status: "pending",
				cost: 0,
				filePath: "/s/parent/zero-cost.jsonl",
			},
		});
		render(<SubagentSheet parentFile="/s/parent.jsonl" row={pendingRow} onClose={() => {}} />);

		expect(await screen.findByText("$0.000")).toBeTruthy();
		expect(screen.queryByText("0秒")).toBeNull();
		expect(screen.queryByText("运行时间")).toBeNull();
	});

	it("overview shows failure reason, solution space and shared context from the row alone", async () => {
		subagentTranscript.mockRejectedValueOnce(new Error("n/a"));
		const r = {
			...row("x"),
			status: "failed" as const,
			error: "sourceSession: must NOT have additional properties",
			solutionSpace: "SOLSPACE-TEXT",
			sharedContext: "CTX-TEXT",
		};
		render(<SubagentSheet parentFile="/s/parent.jsonl" onClose={() => {}} row={r} />);
		expect(screen.getByText(/must NOT have additional properties/)).toBeTruthy();
		expect(screen.getByText("SOLSPACE-TEXT")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /共享上下文/ }));
		expect(screen.getByText("CTX-TEXT")).toBeTruthy();
	});

	it("explicit context prop is used when passed (stream entry point)", async () => {
		subagentTranscript.mockRejectedValueOnce(new Error("n/a"));
		render(<SubagentSheet parentFile="/s/parent.jsonl" onClose={() => {}} row={row("y")} context="PROP-CTX" />);
		fireEvent.click(screen.getByRole("button", { name: /共享上下文/ }));
		expect(screen.getByText("PROP-CTX")).toBeTruthy();
	});

	it("shows active multi-segment total duration and individual run segments in overview", async () => {
		const s1 = new Date(2026, 10, 19, 20, 16, 12);
		const e1 = new Date(2026, 10, 19, 20, 31, 32); // 15m20s
		const s2 = new Date(2026, 10, 19, 20, 34, 22);
		const e2 = new Date(2026, 10, 19, 20, 38, 37); // 4m15s
		const segs = [
			{ startedAt: s1.toISOString(), endedAt: e1.toISOString() },
			{ startedAt: s2.toISOString(), endedAt: e2.toISOString() },
		];
		subagentTranscript.mockResolvedValueOnce({
			...transcript("DONE"),
			summary: {
				id: "multi",
				status: "completed",
				startedAt: segs[0].startedAt,
				endedAt: segs[1].endedAt,
				runSegments: segs,
				toolCallCount: 5,
				requestCount: 2,
				tokens: 1000,
				cost: 0.01,
				filePath: "/s/parent/multi.jsonl",
			},
		});
		render(
			<SubagentSheet
				parentFile="/s/parent.jsonl"
				row={{ ...row("multi"), runSegments: segs, startedAt: segs[0].startedAt, endedAt: segs[1].endedAt }}
				onClose={() => {}}
			/>,
		);

		expect((await screen.findAllByText(/19分35秒/)).length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("运行时间")).toBeTruthy();
		expect(screen.getByText("共 2 段")).toBeTruthy();
		expect(screen.getByText("第 1 段")).toBeTruthy();
		expect(screen.getByText("20:16:12 - 20:31:32 · 15分20秒")).toBeTruthy();
		expect(screen.getByText("第 2 段")).toBeTruthy();
		expect(screen.getByText("20:34:22 - 20:38:37 · 4分15秒")).toBeTruthy();
	});

	it("merges model with thinking level, omits source, and shows ongoing segment when resumed", async () => {
		const s1 = new Date(2026, 10, 19, 20, 16, 12);
		const e1 = new Date(2026, 10, 19, 20, 18, 12);
		const s2 = new Date(2026, 10, 19, 20, 20, 0);
		const segs = [
			{ startedAt: s1.toISOString(), endedAt: e1.toISOString() },
			{ startedAt: s2.toISOString(), endedAt: "" },
		];
		subagentTranscript.mockResolvedValueOnce({
			...transcript(""),
			summary: {
				id: "resumed",
				status: "running",
				model: "openai-codex/gpt-6.2-sol",
				thinkingLevel: "medium",
				startedAt: segs[0].startedAt,
				runSegments: segs,
				toolCallCount: 10,
				requestCount: 2,
				tokens: 1200,
				cost: 0.02,
				filePath: "/s/parent/resumed.jsonl",
			},
		});
		render(
			<SubagentSheet
				parentFile="/s/parent.jsonl"
				row={{
					...row("resumed"),
					status: "running",
					agent: "scout",
					agentSource: "user",
					modelRole: "scout",
					runSegments: segs,
					startedAt: segs[0].startedAt,
				}}
				onClose={() => {}}
			/>,
		);

		expect(await screen.findByText("gpt-6.2-sol (medium)")).toBeTruthy();
		expect(screen.getByText("openai-codex/gpt-6.2-sol · medium")).toBeTruthy();
		expect(screen.getByText("角色: scout")).toBeTruthy();
		expect(screen.queryByText("来源")).toBeNull();
		expect(screen.getByText("工具调用")).toBeTruthy();
		expect(screen.getByText("20:16:12 - 20:18:12 · 2分")).toBeTruthy();
		expect(screen.getByText("20:20:00 - 进行中")).toBeTruthy();
	});

	it("prefers full transcript prompt over truncated row summary and folds systemPrompt into overview", async () => {
		subagentTranscript.mockResolvedValueOnce({
			systemPrompt: "SYS-PROMPT-BODY",
			prompt: "Complete assignment thoroughly: FULL-VERBATIM-PROMPT-TEXT",
			output: "DONE",
			outputPath: null,
			items: [],
			nextByte: 1,
			reset: false,
		});
		render(
			<SubagentSheet
				parentFile="/s/parent.jsonl"
				row={{
					...row("full-prompt"),
					assignment: "TRUNCATED-SUMMARY...",
					task: "TRUNCATED-TASK...",
				}}
				onClose={() => {}}
			/>,
		);

		expect(await screen.findByText("FULL-VERBATIM-PROMPT-TEXT")).toBeTruthy();
		expect(screen.queryByText("TRUNCATED-SUMMARY...")).toBeNull();
		expect(screen.queryByRole("button", { name: "提示词" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /系统提示词/ }));
		expect(screen.getByText("SYS-PROMPT-BODY")).toBeTruthy();
	});
});
