import { describe, expect, it } from "vitest";
import ompWorkspaceAutomation from "../../../../extension/vecway-automation";
import { emptySessionLive, setAutomationDraftStatus, useLive } from "../../../stores/live";
import {
	parseAutomationSessionState,
	parseAutomationStatus,
	parseSavedAutomationState,
} from "./automationStatus";

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

	it("hydrates persisted v2 ompws-automation-state records from disk snapshots", () => {
		const saved = parseSavedAutomationState({
			v: 2,
			mode: "active",
			drafts: [
				{
					v: 1,
					draftId: "draft-disk-1",
					status: "pending",
					draft: {
						name: "X 快速自迭代复盘",
						prompt: "inspect fast iteration",
						summary: "每 4 小时探测触发信号并刷新战术记忆。",
						cwd: "/Users/test/X-creator-lab",
						agentTrigger: "on_signal",
						probeCommand: "node check.mjs",
					},
				},
			],
		});
		expect(saved?.mode).toBe("active");
		expect(saved?.drafts).toHaveLength(1);
		expect(saved?.drafts[0]?.draftId).toBe("draft-disk-1");
		expect(saved?.drafts[0]?.summary).toBe("每 4 小时探测触发信号并刷新战术记忆。");
	});
});

describe("automation mode persistence across draft resolution", () => {
	it("keeps live store automation mode active after enabling or dismissing the last pending draft", () => {
		const draft = {
			draftId: "d-only",
			status: "pending" as const,
			draft: {
				name: "X 日常巡航",
				prompt: "patrol",
				cwd: "/repo",
				runMode: "local" as const,
				cadence: { kind: "interval" as const, minutes: 30 },
				notify: "important" as const,
				enabled: true,
			},
		};
		useLive.setState({
			sessions: {
				"sess-keep": {
					...emptySessionLive(),
					automationState: { mode: "active", drafts: [draft] },
				},
			},
		});

		setAutomationDraftStatus("sess-keep", { ...draft, status: "saved" });
		expect(useLive.getState().sessions["sess-keep"]?.automationState?.mode).toBe("active");
		expect(useLive.getState().sessions["sess-keep"]?.automationState?.drafts[0]?.status).toBe("saved");

		setAutomationDraftStatus("sess-keep", { ...draft, status: "dismissed" });
		expect(useLive.getState().sessions["sess-keep"]?.automationState?.mode).toBe("active");
	});

	it("keeps vecway_automation tool mounted and mode active in extension after resolving all pending drafts", async () => {
		const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		let registeredTool: { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> } | null = null;
		let activeTools = ["read", "bash"];
		let lastStatus: string | undefined;

		const pi = {
			zod: {
				object: (s: unknown) => s,
				string: () => ({ optional: () => ({ describe: () => ({}) }), describe: () => ({}) }),
				number: () => ({ optional: () => ({ describe: () => ({}) }), describe: () => ({}) }),
				boolean: () => ({ optional: () => ({ describe: () => ({}) }), describe: () => ({}) }),
				array: () => ({ optional: () => ({ describe: () => ({}) }), describe: () => ({}) }),
				enum: () => ({ optional: () => ({ describe: () => ({}) }), describe: () => ({}) }),
				unknown: () => ({ optional: () => ({ describe: () => ({}) }), describe: () => ({}) }),
			},
			on: () => {},
			registerTool: (def: { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => {
				registeredTool = def;
			},
			registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				commands.set(name, def.handler);
			},
			appendEntry: () => {},
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
		};

		ompWorkspaceAutomation(pi as never);
		const ctx = {
			cwd: "/repo",
			ui: {
				setStatus: (_key: string, text: string | undefined) => {
					lastStatus = text;
				},
				notify: () => {},
			},
		};

		await commands.get("automation-action")!("enable", ctx);
		expect(activeTools).toContain("vecway_automation");

		const res1 = await registeredTool!.execute(
			"call-1",
			{ action: "propose", draft: { name: "Task A", prompt: "do A" } },
			ctx,
		);
		const match = res1.content[0]?.text.match(/Staged Automation Draft Card \(([^)]+)\)/);
		const draftId = match?.[1];
		expect(draftId).toBeTruthy();

		// Resolve the only pending draft as saved -> mode & tool must remain active
		await commands.get("automation-action")!(`resolve ${draftId} saved`, ctx);
		expect(activeTools).toContain("vecway_automation");
		const stateAfterSave = parseAutomationSessionState(lastStatus);
		expect(stateAfterSave?.mode).toBe("active");

		// Follow-up propose still succeeds without needing /automate again
		const res2 = await registeredTool!.execute(
			"call-2",
			{ action: "propose", draft: { name: "Task B", prompt: "do B" } },
			ctx,
		);
		expect(res2.content[0]?.text).toContain("Task B");

		// Only explicit disable unmounts the tool and turns mode idle
		await commands.get("automation-action")!("disable", ctx);
		expect(activeTools).not.toContain("vecway_automation");
	});
});
