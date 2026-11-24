// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../../core/api";
import { loadUnsent, saveUnsent } from "../chat/lib/unsent";
import { FilesPage } from "./FilesPage";
import { GitPanel, gitCommitSuggest } from "./GitPage";
import { PlanPanel } from "./PlanPage";
import { HANDBACK_MARKER, HANDBACK_PROMPT, SIDECHAT_DRAFT_PREFIX, SidechatPage, SidechatPanel } from "./SidechatPage";
import { useRightDrawer } from "./rightDrawerStore";
describe("gitCommitSuggest", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts to suggest endpoint and returns suggestion text", async () => {
		const apiSpy = vi.spyOn(apiModule, "api").mockResolvedValueOnce({ suggestion: "feat(panels): add mobile panels" });

		const result = await gitCommitSuggest("/sessions/s1/git");
		expect(apiSpy).toHaveBeenCalledWith("POST", "/sessions/s1/git/suggest");
		expect(result).toBe("feat(panels): add mobile panels");
	});

	it("returns empty string when suggestion is missing", async () => {
		vi.spyOn(apiModule, "api").mockResolvedValueOnce({});
		const result = await gitCommitSuggest("/sessions/s1/git");
		expect(result).toBe("");
	});
});

describe("Sidechat Handback", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it("defines valid HANDBACK_MARKER and HANDBACK_PROMPT", () => {
		expect(HANDBACK_MARKER).toBe("【回传整理】");
		expect(HANDBACK_PROMPT).toContain("【回传整理】");
		expect(HANDBACK_PROMPT).toContain("请把我们在这个辅助对话里讨论并确定下来的内容");
	});

	it("stages conclusion into parent composer draft using saveUnsent", () => {
		const parentId = "parent-sess-123";
		const conclusion = "最终方案：选用方案 B，采用纯客户端状态同步。";
		const note = `[来自辅助对话：方案讨论]\n> ${conclusion}`;

		// Pre-existing draft in parent
		saveUnsent(parentId, "原有草稿");
		const prev = loadUnsent(parentId);
		const combined = prev ? `${prev}\n\n${note}` : note;
		saveUnsent(parentId, combined);

		const updated = loadUnsent(parentId);
		expect(updated).toContain("原有草稿");
		expect(updated).toContain("[来自辅助对话：方案讨论]");
		expect(updated).toContain(conclusion);
	});
});

describe("panel presentation contracts", () => {
	beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }));
	afterEach(() => {
		cleanup();
		sessionStorage.clear();
		useRightDrawer.setState({
			open: false,
			sessionId: null,
			tabBySession: {},
			visitedBySession: {},
			pendingSidechat: null,
			pendingMain: null,
		});
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("preserves the annotation sessionStorage handoff and consumes it once", async () => {
		const quote = "请解释这段实现：\n> const answer = 42;";
		const key = `${SIDECHAT_DRAFT_PREFIX}parent`;
		sessionStorage.setItem(key, quote);
		vi.spyOn(apiModule, "api").mockResolvedValue([]);
		render(<SidechatPage route={{ name: "sidechat", path: "/s/parent/sidechat", params: { id: "parent" }, query: {} }} />);
		await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(quote));
		expect(sessionStorage.getItem(key)).toBeNull();
		expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("keeps long file names readable in content instead of squeezing the header", async () => {
		const name = `${"非常长的中文文件名称".repeat(6)}.ts`;
		vi.spyOn(apiModule, "api").mockImplementation(async (_method, path) =>
			path.includes("/file?")
				? { path: `/workspace/${name}`, size: 12, binary: false, truncated: false, text: "const a = 1;" }
				: { path: "/workspace", parent: null, entries: [{ name, path: `/workspace/${name}`, kind: "file", size: 12 }] },
		);
		render(<FilesPage route={{ name: "files", path: "/s/parent/files", params: { id: "parent" }, query: {} }} />);
		fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
		const heading = await screen.findByRole("heading", { name });
		expect(heading.closest("header")).toBeNull();
		expect(screen.getByText("文件预览")).toBeTruthy();
	});

	it("supports Git one-tap AI save, inline manual commit, and per-file action sheet", async () => {
		useRightDrawer.setState({
			open: true,
			sessionId: "s-git-1",
			tabBySession: { "s-git-1": "git" },
			visitedBySession: { "s-git-1": ["git"] },
			pendingSidechat: null,
			pendingMain: null,
		});

		const apiSpy = vi.spyOn(apiModule, "api").mockImplementation(async (method, path) => {
			if (method === "GET" && path.endsWith("/git/status")) {
				return { isRepo: true, branch: "main", files: [{ path: "src/app.ts", status: "M", staged: false, unstaged: true }] };
			}
			if (method === "POST" && path.endsWith("/git/suggest")) return { suggestion: "feat: one tap ai save" };
			if (method === "POST" && path.endsWith("/git/stage")) return { ok: true };
			if (method === "POST" && path.endsWith("/git/commit")) return { ok: true };
			if (method === "GET" && path.includes("/git/diff?")) return { diff: "+export const ok = true;" };
			return {};
		});

		render(<GitPanel sessionId="s-git-1" embedded />);
		await screen.findByText("app.ts");

		// One-tap AI save stages & commits automatically
		fireEvent.click(screen.getByRole("button", { name: /AI 生成并提交/ }));
		await waitFor(() => expect(apiSpy).toHaveBeenCalledWith("POST", "/sessions/s-git-1/git/commit", { message: "feat: one tap ai save" }));
		expect(apiSpy).toHaveBeenCalledWith("POST", "/sessions/s-git-1/git/stage", { paths: ["src/app.ts"] });

		// Manual commit modal flow
		fireEvent.click(screen.getByRole("button", { name: /填写说明提交/ }));
		const box = await screen.findByRole("textbox", { name: "提交说明" }) as HTMLTextAreaElement;
		await waitFor(() => expect(box.value).toBe("feat: one tap ai save"));
		fireEvent.change(box, { target: { value: "fix: manual override" } });
		fireEvent.click(screen.getByRole("button", { name: "确认提交" }));
		await waitFor(() => expect(apiSpy).toHaveBeenCalledWith("POST", "/sessions/s-git-1/git/commit", { message: "fix: manual override" }));

		// Per-file BottomSheet action menu -> DiffOverlay with 发给主对话
		fireEvent.click(screen.getByRole("button", { name: "操作 app.ts" }));
		await screen.findByText("让 Agent 审查或修改此文件");
		fireEvent.click(screen.getByRole("button", { name: /查看改动差异/ }));
		await screen.findByText("改动差异");
		expect(screen.getByRole("button", { name: /发给主对话/ })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "返回列表" }));

		// Per-file BottomSheet -> send file directly to main chat and close drawer
		fireEvent.click(screen.getByRole("button", { name: "操作 app.ts" }));
		fireEvent.click(await screen.findByRole("button", { name: /让 Agent 审查或修改此文件/ }));
		expect(useRightDrawer.getState().open).toBe(false);
		expect(useRightDrawer.getState().pendingMain?.payload.sourceLabel).toBe("Git 改动 · src/app.ts");
	});

	it("renders compact 2-row sticky PlanPanel header with TOC popover and progress pill", async () => {
		const scrollMock = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollMock });

		vi.spyOn(apiModule, "api").mockImplementation(async (_m, path) => {
			if (path.endsWith("/plan")) {
				return {
					streaming: false,
					planStatus: {
						enabled: true,
						phase: "review",
						title: "重构计划",
						version: 2,
						content: "# 总体目标\n\n- [x] 步骤一\n- [ ] 步骤二\n\n## 实现细节\n\n正文\n\n### 验证清单\n\n完成",
						approved: null,
					},
				};
			}
			return null;
		});

		render(<PlanPanel sessionId="s-plan-1" embedded />);
		await screen.findByText("重构计划");
		expect(screen.queryByText("v2")).toBeNull();
		expect(screen.getByText("1/2")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
		expect(screen.getByRole("button", { name: "复制计划" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "刷新计划" })).toBeTruthy();

		const tocBtn = screen.getByRole("button", { name: /目录 · 3 章节/ });
		fireEvent.click(tocBtn);
		await screen.findByText("计划目录");
		fireEvent.click(screen.getByRole("button", { name: "实现细节" }));
		expect(scrollMock).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
	});

	it("syncs PlanPanel TOC headings when planStatus already arrives from composer-state before /plan resolves", async () => {
		const planStatus = {
			enabled: true,
			phase: "review",
			title: "预置计划",
			version: 2,
			content: "# 总体目标\n\n## 第一阶段\n\n- [ ] 任务一\n\n## 第二阶段\n\n- [ ] 任务二",
			approved: null,
		};
		let resolvePlan!: (v: unknown) => void;
		const delayedPlan = new Promise((r) => {
			resolvePlan = r;
		});

		vi.spyOn(apiModule, "api").mockImplementation(async (_m, path) => {
			if (path.endsWith("/composer-state")) return { streaming: false, planMode: true, planStatus };
			if (path.endsWith("/plan")) return delayedPlan;
			return null;
		});

		render(<PlanPanel sessionId="s-plan-preloaded" embedded />);
		await screen.findByText("预置计划");
		resolvePlan({ streaming: false, planStatus });
		await screen.findByRole("button", { name: /目录 · 3 章节/ });
	});

	it("handles wrapped { sidechats } payloads safely in SidechatPanel", async () => {
		vi.spyOn(apiModule, "api").mockImplementation(async (_m, path) => {
			if (path.endsWith("/sidechats")) {
				return {
					sidechats: [
						{ id: "sc-wrap-1", label: "#1", title: "兼容数组包装", status: "idle", updatedAt: "2026-11-22T10:00:00Z", cwd: "/proj", live: true },
					],
				};
			}
			if (path.includes("/transcript?")) return { items: [], reset: true };
			return {};
		});

		render(<SidechatPanel sessionId="s-side-wrap" embedded />);
		await screen.findByText("开始一段新的辅助对话");
	});
});
