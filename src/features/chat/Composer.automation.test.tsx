// @vitest-environment jsdom
/**
 * PromptComposer (shared non-session prompt builder): hydrates prompt/attachments
 * without touching live RPC or the global useComposer store, uses compact single-line
 * starting height (rows=1, minH=26), resolves default model role so ThinkingLevelPicker
 * is active, keeps Enter as newline, and routes workspace/runMode via ear-tab popovers.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "../../lib/ipc";
import type { ModelOption } from "../../lib/models";
import { useComposer } from "../../stores/composer";
import { useSessions } from "../../stores/sessions";
import { PromptComposer } from "./PromptComposer";

const h = vi.hoisted(() => ({
	rpcSend: vi.fn(async () => ({}) as Record<string, unknown>),
	rpcEnsureLive: vi.fn(async () => ({ sessionId: "unexpected" })),
	sessionSnapshot: vi.fn(async () => ({})),
	sessionUsage: vi.fn(async () => ({ available: false, tokens: 0 })),
	ompModelRolesRead: vi.fn(async () => ({
		global: { modelRoles: { default: "anthropic/claude-opus-4-5" } },
		project: null,
	})),
	gitListWorktrees: vi.fn(async () => [
		{
			path: "/tmp/proj-a",
			branch: "main",
			head: "1111111",
			dirty: 0,
			sessionIds: [],
			ahead: 0,
			behind: 0,
		},
		{
			path: "/tmp/proj-a/.worktrees/feature-watch",
			branch: "omp/feature-watch",
			head: "2222222",
			dirty: 0,
			sessionIds: [],
			ahead: 1,
			behind: 0,
		},
	]),
}));

const MOCK_MODELS: ModelOption[] = [
	{
		provider: "anthropic",
		id: "claude-opus-4-5",
		name: "Claude Opus 4.5",
		reasoning: true,
		thinking: ["off", "low", "medium", "high"],
	},
];

vi.mock("../../lib/ipc", async (importOriginal) => {
	const orig = await importOriginal<typeof IpcModule>();
	return {
		...orig,
		rpcSend: h.rpcSend,
		rpcEnsureLive: h.rpcEnsureLive,
		sessionSnapshot: h.sessionSnapshot,
		sessionUsage: h.sessionUsage,
		ompModelRolesRead: h.ompModelRolesRead,
		skillsList: vi.fn(async () => ({ skills: [], extensions: [] })),
		listWorkspaceFiles: vi.fn(async () => []),
		getSettings: vi.fn(async () => null),
		gitBadge: vi.fn(async () => null),
		gitListWorktrees: h.gitListWorktrees,
		privacyList: vi.fn(async () => ({ entries: [], nativeStatus: "missing", nativeError: null })),
		privacySessionEntryIds: vi.fn(async () => []),
	};
});

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@tauri-apps/api/core")>();
	return {
		...orig,
		convertFileSrc: (path: string) => `asset://${path}`,
	};
});

vi.mock("@tauri-apps/api/webview", () => ({
	getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

vi.mock("../../stores/modelCatalog", () => ({
	useModelOptions: () => MOCK_MODELS,
	useModelCatalog: Object.assign(vi.fn(() => MOCK_MODELS), {
		getState: () => ({ models: MOCK_MODELS, refresh: () => Promise.resolve() }),
	}),
}));

beforeAll(() => {
	class RO {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", RO);
	Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
	h.rpcSend.mockClear();
	h.rpcEnsureLive.mockClear();
	h.sessionSnapshot.mockClear();
	h.sessionUsage.mockClear();
	h.ompModelRolesRead.mockClear();
	useComposer.setState({ drafts: {}, annotations: {}, images: {}, files: {}, history: ["prev"] });
	useSessions.setState({
		hasLoaded: true,
		loadError: null,
		workspaces: [
			{ id: "ws-1", name: "proj-a", path: "/tmp/proj-a", kind: "project", sort: 0, mode: "code" },
			{ id: "ws-2", name: "proj-b", path: "/tmp/proj-b", kind: "project", sort: 1, mode: "code" },
		],
		sessions: {},
	});
});

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
});

describe("PromptComposer (shared non-session prompt builder)", () => {
	it("hydrates prompt with compact single-line height, resolves default model & thinking levels, and picks workspace & worktree in ear", async () => {
		const onChangePrompt = vi.fn();
		const onChangeModel = vi.fn();
		const onChangeCwd = vi.fn();
		const onChangeRunMode = vi.fn();

		render(
			<PromptComposer
				id="automation-config:test"
				placeholder="输入指令"
				cwd="/tmp/proj-a"
				onChangeCwd={onChangeCwd}
				workspaceMode="code"
				runMode="local"
				isGitRepo={true}
				onChangeRunMode={onChangeRunMode}
				modelValue=""
				onChangeModel={onChangeModel}
				promptValue="分析 [Image #1: /tmp/a.png]"
				onChangePrompt={onChangePrompt}
			/>,
		);

		const ta = document.querySelector<HTMLTextAreaElement>(
			'textarea[data-composer="automation-config:test"]',
		);
		expect(ta).toBeTruthy();
		expect(ta!.value).toBe("分析 🖼️#1");
		// Compact starting height matching main chat Composer (no bloated 3-row / 84px hollow box).
		expect(ta!.rows).toBe(1);
		expect(ta!.style.height).toBe("26px");

		// Never spawns or fetches session RPC state, and never pollutes global useComposer store.
		expect(h.rpcEnsureLive).not.toHaveBeenCalled();
		expect(h.sessionSnapshot).not.toHaveBeenCalled();
		expect(h.sessionUsage).not.toHaveBeenCalled();
		expect(useComposer.getState().drafts["automation-config:test"]).toBeUndefined();

		// Default model resolves without "默认模型" prefix and activates ThinkingLevelPicker.
		await waitFor(() => {
			expect(screen.queryByText("不支持思考")).toBeNull();
			expect(screen.getByText("claude-opus-4-5")).toBeTruthy();
		});
		expect(screen.queryByText(/默认模型/)).toBeNull();
		expect(screen.getByRole("button", { name: /auto/ })).toBeTruthy();

		// Switching thinking level stores ":high" over default model.
		fireEvent.click(screen.getByRole("button", { name: /auto/ }));
		fireEvent.click(await screen.findByRole("button", { name: /Auto/ }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: /high/ }));
		expect(onChangeModel).toHaveBeenCalledWith(":high");

		// Typing updates serialized promptValue; Enter does not submit.
		fireEvent.change(ta!, { target: { value: "分析 🖼️#1 并修复" } });
		expect(onChangePrompt).toHaveBeenCalledWith("分析 [Image #1: /tmp/a.png] 并修复");
		fireEvent.keyDown(ta!, { key: "Enter" });
		expect(h.rpcSend).not.toHaveBeenCalled();

		// Ear-tab project picker switches cwd cleanly.
		fireEvent.click(screen.getByRole("button", { name: /proj-a/ }));
		fireEvent.click(await screen.findByRole("button", { name: /proj-b/ }));
		expect(onChangeCwd).toHaveBeenCalledWith("/tmp/proj-b");

		// Ear-tab runMode picker lists existing linked worktrees and lets user target one directly.
		fireEvent.click(screen.getByRole("button", { name: /当前目录/ }));
		fireEvent.click(await screen.findByRole("button", { name: /omp\/feature-watch/ }));
		expect(onChangeCwd).toHaveBeenCalledWith("/tmp/proj-a/.worktrees/feature-watch");
		expect(onChangeRunMode).toHaveBeenCalledWith("local");

		// Ear-tab runMode picker also switches to isolated per-run Worktree cleanly.
		fireEvent.click(screen.getByRole("button", { name: /当前目录/ }));
		fireEvent.click(await screen.findByRole("button", { name: /独立工作树/ }));
		expect(onChangeRunMode).toHaveBeenCalledWith("worktree");
	});
});
