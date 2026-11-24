// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ method: string; path: string; body?: unknown }> = [];
vi.mock("../../core/api", async (orig) => {
	const real = await orig<typeof import("../../core/api")>();
	return {
		...real,
		api: vi.fn(async (method: string, path: string, body?: unknown) => {
			calls.push({ method, path, body });
			if (path === "/left/dirs") return { dirs: [{ path: "/w", label: "w" }] };
			return {};
		}),
	};
});

import { ScheduleFormPage } from "./ScheduleFormPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ScheduleFormPage", () => {
	let host: HTMLDivElement;
	beforeEach(() => {
		calls.length = 0;
		host = document.createElement("div");
		document.body.appendChild(host);
	});
	afterEach(() => host.remove());

	it("keeps the form and footer constrained to the viewport", async () => {
		const root = createRoot(host);
		await act(async () => root.render(<ScheduleFormPage />));
		const scroller = host.querySelector(".overflow-y-auto")!;
		expect(scroller.className).toContain("min-w-0");
		expect(scroller.className).toContain("w-full");
		const footer = [...host.querySelectorAll("button")].find((b) => b.textContent === "保存")!.parentElement!;
		expect(footer.style.paddingBottom).toBe("max(12px, min(var(--m-safe-bottom), 34px))");
		await act(async () => root.unmount());
	});

	it("does not offer a per-automation overlap policy", async () => {
		const root = createRoot(host);
		await act(async () => root.render(<ScheduleFormPage />));
		expect(host.querySelector('[role="radiogroup"][aria-label="运行重合策略"]')).toBeNull();
		expect(host.textContent).not.toContain("上次运行未结束时");
		await act(async () => root.unmount());
	});

	it("constrains date, time and interval inputs to the form width", async () => {
		const root = createRoot(host);
		await act(async () => root.render(<ScheduleFormPage />));
		const check = (selector: string) => {
			const input = host.querySelector<HTMLInputElement>(selector);
			expect(input).not.toBeNull();
			expect(input!.className).toContain("min-w-0");
			expect(input!.className).toContain("max-w-full");
			expect(input!.className).toContain("box-border");
			if (input!.type === "time" || input!.type === "datetime-local") {
				const frame = input!.closest("[data-date-input-frame]");
				expect(frame?.className).toContain("overflow-hidden");
				expect(frame?.className).toContain("rounded-[14px]");
				expect(input!.style.width).toBe("100%");
			}
		};
		check('input[type="time"]');
		check('input[type="datetime-local"]');
		const choose = async (label: string) => {
			const rowBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
				b.getAttribute("aria-label")?.startsWith("重复方式"),
			)!;
			await act(async () => rowBtn.click());
			const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((b) =>
				b.textContent?.includes(label),
			)!;
			await act(async () => item.click());
		};
		await choose("仅一次");
		check('input[type="datetime-local"]');
		await choose("每月");
		check('input[type="time"]');
		await choose("间隔");
		check('input[type="number"]');
		await act(async () => root.unmount());
	});

	it("shows full inline validation errors and does not submit an invalid form", async () => {
		const root = createRoot(host);
		await act(async () => root.render(<ScheduleFormPage />));
		const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "保存") as HTMLButtonElement;
		await act(async () => save.click());
		const alerts = [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
		expect(alerts).toContain("请填写任务名称");
		expect(alerts.some((t) => t?.includes("请填写提示词"))).toBe(true);
		expect(calls.some((c) => c.method === "POST")).toBe(false);
		await act(async () => root.unmount());
	});

	it("preserves probeCommand, agentTrigger, and resultMode losslessly when editing an existing schedule", async () => {
		const { api } = await import("../../core/api");
		const baseMock = vi.mocked(api).getMockImplementation()!;
		const existing = {
			id: "sched-keep",
			name: "磁盘巡检",
			prompt: "分析磁盘告警",
			cwd: "/w",
			mode: "code",
			runMode: "local",
			cadence: { kind: "interval", minutes: 30 },
			model: null,
			thinking: null,
			approvalMode: null,
			enabled: true,
			nextRunAt: null,
			lastRunAt: null,
			lastRunStatus: null,
			notify: "important",
			newChatEachRun: true,
			endAt: null,
			lifecycle: "active",
			maxRuns: null,
			runsDone: 0,
			probeCommand: "df -h / | awk 'NR==2'",
			probeDescription: "检查根分区",
			agentTrigger: "on_signal",
			resultMode: "llm_summary",
			invokesExternalModel: true,
		};
		vi.mocked(api).mockImplementation(async (method: string, path: string, body?: unknown) => {
			calls.push({ method, path, body });
			if (path === "/left/schedules") return [existing];
			if (path === "/left/schedules/sched-keep/runs") return [];
			if (path === "/left/schedules/sched-keep/worktree") return null;
			if (path === "/left/dirs") return { dirs: [{ path: "/w", label: "w" }] };
			if (method === "PUT" && path === "/left/schedules/sched-keep") return { ...existing, ...(body as object) };
			return {};
		});
		try {
			const root = createRoot(host);
			await act(async () => root.render(<ScheduleFormPage id="sched-keep" />));
			// Switch from 运维总览 tab to 配置 tab
			const configTab = [...host.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((b) =>
				b.textContent?.includes("配置"),
			)!;
			await act(async () => configTab.click());
			const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "保存")!;
			await act(async () => save.click());
			const putCall = calls.find((c) => c.method === "PUT" && c.path === "/left/schedules/sched-keep");
			expect(putCall).toBeDefined();
			expect((putCall?.body as Record<string, unknown>).probeCommand).toBe("df -h / | awk 'NR==2'");
			expect((putCall?.body as Record<string, unknown>).agentTrigger).toBe("on_signal");
			expect((putCall?.body as Record<string, unknown>).resultMode).toBe("llm_summary");
			expect((putCall?.body as Record<string, unknown>).invokesExternalModel).toBe(true);
			await act(async () => root.unmount());
		} finally {
			vi.mocked(api).mockImplementation(baseMock);
		}
	});

	it("validates fields inline on blur and persists unsaved drafts in sessionStorage", async () => {
		sessionStorage.clear();
		const root = createRoot(host);
		await act(async () => root.render(<ScheduleFormPage />));
		const nameInput = host.querySelector<HTMLInputElement>('div[data-field="name"] input')!;
		await act(async () => {
			nameInput.focus();
			nameInput.blur();
		});
		expect([...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent)).toContain("请填写任务名称");

		// Typing a draft caches it in sessionStorage so a remount restores it automatically
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
		await act(async () => {
			setter.call(nameInput, "未保存草稿任务");
			nameInput.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => root.unmount());

		const root2 = createRoot(host);
		await act(async () => root2.render(<ScheduleFormPage />));
		const restoredInput = host.querySelector<HTMLInputElement>('div[data-field="name"] input')!;
		expect(restoredInput.value).toBe("未保存草稿任务");
		expect(host.textContent).toContain("已自动恢复上次未保存草稿");
		sessionStorage.clear();
		await act(async () => root2.unmount());
	});

	it("opens Config tab directly via ?tab=config, rebases only dirty fields on server revision change, preserves mid-save edits, and seeds new forms from global defaults", async () => {
		sessionStorage.clear();
		const { api } = await import("../../core/api");
		const baseMock = vi.mocked(api).getMockImplementation()!;
		let resolvePut!: (v: unknown) => void;
		let serverSched = {
			id: "sched-rev",
			name: "原始任务",
			prompt: "原始提示词",
			cwd: "/w",
			mode: "code",
			runMode: "local",
			cadence: { kind: "interval", minutes: 30 },
			model: null,
			thinking: null,
			approvalMode: null,
			enabled: true,
			nextRunAt: null,
			lastRunAt: null,
			lastRunStatus: null,
			notify: "important",
			newChatEachRun: true,
			endAt: null,
			lifecycle: "active",
			maxRuns: null,
			runsDone: 0,
			probeCommand: "old-probe.sh",
			probeDescription: "旧脚本",
			agentTrigger: "on_signal",
			resultMode: "structured",
			invokesExternalModel: false,
			updatedAt: "2026-11-24T10:00:00Z",
		};
		vi.mocked(api).mockImplementation(async (method: string, path: string, body?: unknown) => {
			calls.push({ method, path, body });
			if (path === "/left/dirs") return { dirs: [{ path: "/w", label: "w" }] };
			if (path === "/left/schedules") return [serverSched];
			if (path === "/left/settings") {
				return {
					automationDefaultResultMode: "llm_summary",
					automationDefaultModel: "openai/gpt-5",
					automationDefaultThinking: "high",
				};
			}
			if (method === "PUT" && path === "/left/schedules/sched-rev") {
				return new Promise((resolve) => {
					resolvePut = resolve;
				});
			}
			return {};
		});
		try {
			// 1. New form seeds from /left/settings defaults
			const rootNew = createRoot(host);
			await act(async () => rootNew.render(<ScheduleFormPage />));
			expect(host.textContent).toContain("openai/gpt-5 · high");
			await act(async () => rootNew.unmount());

			// 2. Detail form with ?tab=config opens Config tab directly
			window.location.hash = "#/schedules/sched-rev?tab=config";
			const root1 = createRoot(host);
			await act(async () => root1.render(<ScheduleFormPage id="sched-rev" />));
			const nameInput = host.querySelector<HTMLInputElement>('div[data-field="name"] input')!;
			expect(nameInput.value).toBe("原始任务");

			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
			await act(async () => {
				setter.call(nameInput, "本地未保存名称");
				nameInput.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await act(async () => root1.unmount());

			// 3. Server schedule updates (e.g. AI repair in Overview changed probeCommand & updatedAt)
			serverSched = {
				...serverSched,
				probeCommand: "repaired-probe.sh",
				updatedAt: "2026-11-24T10:05:00Z",
			};
			const root2 = createRoot(host);
			await act(async () => root2.render(<ScheduleFormPage id="sched-rev" initialTab="config" />));
			const nameInput2 = host.querySelector<HTMLInputElement>('div[data-field="name"] input')!;
			const probeTextarea = host.querySelector<HTMLTextAreaElement>('div[data-field="probeCommand"] textarea')!;
			expect(nameInput2.value).toBe("本地未保存名称");
			expect(probeTextarea.value).toBe("repaired-probe.sh");

			// 4. Editing further while Save is in flight preserves newer edits in sessionStorage
			const saveBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "保存")!;
			await act(async () => saveBtn.click());
			await act(async () => {
				setter.call(nameInput2, "保存期间继续编辑");
				nameInput2.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await act(async () => resolvePut({ ...serverSched, name: "本地未保存名称" }));
			expect(sessionStorage.getItem("omp:mobile:schedule-draft:sched-rev")).toContain("保存期间继续编辑");
			await act(async () => root2.unmount());
		} finally {
			window.location.hash = "";
			sessionStorage.clear();
			vi.mocked(api).mockImplementation(baseMock);
		}
	});
});
