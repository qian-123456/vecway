import { describe, expect, it } from "vitest";
import { parseAutomationSessionState, parseAutomationStatus } from "./automationStatus";

describe("parseAutomationStatus", () => {
	it("returns null on malformed or mismatched version payloads", () => {
		expect(parseAutomationStatus("not json")).toBeNull();
		expect(parseAutomationStatus(JSON.stringify({ v: 2, draftId: "d1", draft: {} }))).toBeNull();
		expect(parseAutomationStatus(undefined)).toBeNull();
	});

	it("parses pending draft with normalized cadence and probe fields", () => {
		const raw = JSON.stringify({
			v: 1,
			draftId: "draft-1",
			status: "pending",
			draft: {
				name: "检查错误日志",
				cadence: { kind: "interval", minutes: 2 },
				agentTrigger: "on_signal",
				probeDescription: "检查新增 ERROR",
				probeCommand: "bash '/tmp/check.sh'",
				prompt: "分析错误",
				cwd: "/repo",
			},
		});
		const res = parseAutomationStatus(raw);
		expect(res).toEqual({
			draftId: "draft-1",
			status: "pending",
			draft: {
				id: undefined,
				name: "检查错误日志",
				cadence: { kind: "interval", minutes: 2 },
				agentTrigger: "on_signal",
				probeDescription: "检查新增 ERROR",
				probeCommand: "bash '/tmp/check.sh'",
				prompt: "分析错误",
				cwd: "/repo",
				runMode: "local",
				model: null,
				thinking: null,
				notify: "important",
				resultMode: "structured",
				invokesExternalModel: false,
				enabled: true,
			},
		});
	});

	it("parses multi-draft session state with model, thinking, resultMode and external model flag", () => {
		const raw = JSON.stringify({
			v: 1,
			mode: "active",
			drafts: [
				{
					draftId: "d1",
					status: "pending",
					draft: {
						name: "日常巡航",
						prompt: "run patrol",
						model: "sub2api-smart/gpt-6-luna",
						thinking: "low",
						resultMode: "structured",
						agentTrigger: "on_signal",
						probeCommand: "node '/tmp/check.mjs'",
					},
				},
				{
					draftId: "d2",
					status: "pending",
					draft: {
						name: "外部流水线",
						prompt: "",
						agentTrigger: "never",
						resultMode: "llm_summary",
						invokesExternalModel: true,
						probeCommand: "bash '/tmp/pipeline.sh'",
					},
				},
			],
		});
		const state = parseAutomationSessionState(raw);
		expect(state?.mode).toBe("active");
		expect(state?.drafts).toHaveLength(2);
		expect(state?.drafts[0]?.draft.model).toBe("sub2api-smart/gpt-6-luna");
		expect(state?.drafts[0]?.draft.thinking).toBe("low");
		expect(state?.drafts[1]?.draft.resultMode).toBe("llm_summary");
		expect(state?.drafts[1]?.draft.invokesExternalModel).toBe(true);
	});

	it.each(["skip", "coalesce", "queue", "parallel", "invalid"])("ignores legacy task overlap policy %s", (overlapPolicy) => {
		const result = parseAutomationStatus(JSON.stringify({ v: 1, draftId: "d", draft: { overlapPolicy } }));
		expect(result?.draft).not.toHaveProperty("overlapPolicy");
	});

	it("preserves optional human-facing draft summary when provided", () => {
		const result = parseAutomationStatus(
			JSON.stringify({
				v: 1,
				draftId: "d2",
				status: "pending",
				draft: {
					name: "X 自动互动",
					prompt: "Long machine prompt...",
					summary: "用浏览器完成一次互动巡检与回复，不发主帖。",
				},
			}),
		);
		expect(result?.summary).toBe("用浏览器完成一次互动巡检与回复，不发主帖。");
	});
});
