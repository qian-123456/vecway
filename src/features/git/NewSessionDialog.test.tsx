// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";

const mocks = vi.hoisted(() => ({
	closeModal: vi.fn(),
	selectSession: vi.fn(),
	createSession: vi.fn(),
	sendFirstPrompt: vi.fn(),
	gitCreateWorktree: vi.fn(),
	gitRepoRoot: vi.fn(),
	gitBadge: vi.fn(),
	gitListBranches: vi.fn(),
	rpcListLive: vi.fn(),
	deleteSession: vi.fn(),
	validatePath: vi.fn(),
	appPaths: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../components/Modal", () => ({
	Modal: ({ children }: PropsWithChildren) => <div role="dialog">{children}</div>,
}));
vi.mock("../../components/ModelSelect", () => ({ ModelSelect: () => null }));
vi.mock("../../lib/createSession", () => ({
	createSession: mocks.createSession,
	sendFirstPrompt: mocks.sendFirstPrompt,
}));
vi.mock("../../lib/ipc", () => ({
	appPaths: mocks.appPaths,
	deleteSession: mocks.deleteSession,
	gitBadge: mocks.gitBadge,
	gitCreateWorktree: mocks.gitCreateWorktree,
	gitListBranches: mocks.gitListBranches,
	gitRepoRoot: mocks.gitRepoRoot,
	rpcListLive: mocks.rpcListLive,
	rpcSend: vi.fn(),
	validatePath: mocks.validatePath,
}));
vi.mock("../../lib/toast", () => ({
	toast: { error: mocks.toastError, success: mocks.toastSuccess, info: vi.fn() },
}));
vi.mock("../../stores/modelCatalog", () => ({
	useModelCatalog: { getState: () => ({ refresh: vi.fn(async () => {}), models: [{ provider: "p", id: "m" }] }) },
	useModelOptions: () => [],
}));
vi.mock("../../stores/worktrees", () => ({
	useWorktrees: { getState: () => ({ refresh: vi.fn(async () => {}) }) },
}));
vi.mock("../sessions/sidebarStore", () => ({
	useSidebarStore: (sel: (s: { activeMode: string }) => unknown) => sel({ activeMode: "code" }),
}));
vi.mock("../settings/store", () => ({
	useSettings: (sel: (s: { settings: { newSessionModel: null } }) => unknown) =>
		sel({ settings: { newSessionModel: null } }),
}));
vi.mock("../../stores/ui", async () => {
	const { create } = await import("zustand");
	return {
		useUi: create(() => ({
			modal: null as { name: string; props: Record<string, unknown> } | null,
			closeModal: mocks.closeModal,
			selectSession: mocks.selectSession,
		})),
	};
});

import { useComposer } from "../../stores/composer";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { NewSessionDialog } from "./NewSessionDialog";

describe("NewSessionDialog safety & staged retry", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useComposer.setState({ drafts: {} });
		useSessions.setState({
			workspaces: [{ id: "ws1", name: "Repo", path: "/repo", mode: "code" } as never],
			sessions: {},
		});
		mocks.appPaths.mockResolvedValue({ globalDir: "/global" });
		mocks.validatePath.mockResolvedValue({ exists: true, isDir: true });
		mocks.gitRepoRoot.mockResolvedValue("/repo");
		mocks.gitBadge.mockResolvedValue({ isRepo: true, isWorktree: false, worktreeName: null });
		mocks.gitListBranches.mockResolvedValue(["main"]);
		mocks.gitCreateWorktree.mockResolvedValue({ path: "/repo/.worktrees/wt1" });
		mocks.createSession.mockResolvedValue({
			sessionId: "sess-1",
			stub: { id: "sess-1", cwd: "/repo", status: "idle", mode: "code" },
		});
		mocks.sendFirstPrompt.mockResolvedValue(undefined);
		mocks.rpcListLive.mockResolvedValue([{ sessionId: "sess-1" }]);
		mocks.deleteSession.mockResolvedValue(undefined);
		useUi.setState({ modal: { name: "new-session", props: { workspaceId: "ws1" } } });
	});
	afterEach(cleanup);

	it("does not block submission on a non-git directory and hides worktree controls", async () => {
		mocks.gitRepoRoot.mockResolvedValue(null);
		mocks.gitBadge.mockResolvedValue({ isRepo: false, isWorktree: false, worktreeName: null });
		render(<NewSessionDialog />);
		await waitFor(() => expect(mocks.gitRepoRoot).toHaveBeenCalled());
		const submitBtn = screen.getByRole("button", { name: "创建会话" }) as HTMLButtonElement;
		expect(submitBtn.disabled).toBe(false);
		fireEvent.click(submitBtn);
		await waitFor(() => expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" })));
	});

	it("preserves draft and retries sendFirstPrompt without creating a duplicate session when initial send fails on a live session", async () => {
		mocks.sendFirstPrompt
			.mockRejectedValueOnce(new Error("timeout"))
			.mockResolvedValueOnce(undefined);

		render(<NewSessionDialog />);
		const textarea = screen.getByPlaceholderText(/创建后立即发送/);
		fireEvent.change(textarea, { target: { value: "important first message" } });
		fireEvent.click(screen.getByRole("button", { name: "创建会话" }));

		await screen.findByText(/timeout/);
		expect(useComposer.getState().drafts["sess-1"]).toBe("important first message");

		// Clicking Retry Send retries prompt on the SAME session without calling createSession again
		const retryBtns = screen.getAllByRole("button", { name: "重试发送" });
		fireEvent.click(retryBtns[0]);
		await waitFor(() => expect(mocks.sendFirstPrompt).toHaveBeenCalledTimes(2));
		expect(mocks.createSession).toHaveBeenCalledTimes(1);
		expect(mocks.selectSession).toHaveBeenCalledWith("sess-1");
		expect(mocks.closeModal).toHaveBeenCalled();
	});

	it("awaits cwd-keyed gitRepoRoot probe when useWorktree is enabled instead of using previous non-git directory result (H10)", async () => {
		useSessions.setState({
			workspaces: [
				{ id: "ws-nongit", name: "Plain", path: "/plain", mode: "code" } as never,
				{ id: "ws-git", name: "Repo", path: "/repo", mode: "code" } as never,
			],
			sessions: {},
		});
		let resolveRepoProbe!: (val: string | null) => void;
		mocks.gitRepoRoot.mockImplementation((dir: string) => {
			if (dir === "/plain") {
				return Promise.resolve(null);
			}
			return new Promise((resolve) => {
				resolveRepoProbe = resolve;
			});
		});
		mocks.gitBadge.mockResolvedValue({ isRepo: false, isWorktree: false, worktreeName: null });
		useUi.setState({
			modal: {
				name: "new-session",
				props: { workspaceId: "ws-nongit", useWorktree: true },
			},
		});

		render(<NewSessionDialog />);
		await waitFor(() => expect(mocks.gitRepoRoot).toHaveBeenCalledWith("/plain"));

		// Switch workspace to /repo whose gitRepoRoot probe is still pending
		const selects = screen.getAllByRole("combobox");
		fireEvent.change(selects[0], { target: { value: "ws-git" } });
		await waitFor(() => expect(mocks.gitRepoRoot).toHaveBeenCalledWith("/repo"));

		// Submit immediately before /repo probe resolves
		fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
		expect(mocks.createSession).not.toHaveBeenCalled();

		resolveRepoProbe("/repo");
		await waitFor(() => expect(mocks.gitCreateWorktree).toHaveBeenCalledWith("/repo", expect.any(String), expect.any(Object)));
		expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo/.worktrees/wt1" }));
	});

	it("does not clobber newer composer edits on background retry and copies latest edited prompt on Open Session (M15)", async () => {
		let rejectFirst!: (err: Error) => void;
		mocks.sendFirstPrompt
			.mockImplementationOnce(() => new Promise((_, rej) => { rejectFirst = rej; }))
			.mockResolvedValueOnce(undefined);

		render(<NewSessionDialog />);
		const textarea = screen.getByPlaceholderText(/创建后立即发送/);
		fireEvent.change(textarea, { target: { value: "captured initial prompt" } });
		fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
		await waitFor(() => expect(mocks.sendFirstPrompt).toHaveBeenCalledTimes(1));

		// Close dialog while send is in flight -> background mode
		fireEvent.click(screen.getByRole("button", { name: "后台继续" }));
		rejectFirst(new Error("network down"));

		await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
		expect(useComposer.getState().drafts["sess-1"]).toBe("captured initial prompt");

		// User opens the session and edits its draft after the failure
		useComposer.getState().setDraft("sess-1", "newer user edit");

		// Clicking toast Retry Send sends captured initial prompt and keeps newer user edit
		const action = mocks.toastError.mock.calls[0][2] as { label: string; onClick: () => void };
		action.onClick();
		await waitFor(() => expect(mocks.sendFirstPrompt).toHaveBeenCalledTimes(2));
		expect(mocks.sendFirstPrompt).toHaveBeenLastCalledWith("sess-1", "captured initial prompt");
		expect(useComposer.getState().drafts["sess-1"]).toBe("newer user edit");
	});

	it("copies latest edited prompt from dialog into session draft when clicking Open Session after failure (M15)", async () => {
		mocks.sendFirstPrompt.mockRejectedValueOnce(new Error("send failed"));
		render(<NewSessionDialog />);
		const textarea = screen.getByPlaceholderText(/创建后立即发送/);
		fireEvent.change(textarea, { target: { value: "first version" } });
		fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
		await screen.findByText(/send failed/);

		fireEvent.change(textarea, { target: { value: "edited before open" } });
		fireEvent.click(screen.getByRole("button", { name: "打开会话" }));

		expect(useComposer.getState().drafts["sess-1"]).toBe("edited before open");
		expect(mocks.selectSession).toHaveBeenCalledWith("sess-1");
		expect(mocks.closeModal).toHaveBeenCalled();
	});

	it("blocks isolated launch when gitRepoRoot probe fails and retries cleanly (M9 / P2-6)", async () => {
		mocks.gitRepoRoot
			.mockRejectedValueOnce(new Error("git exited 128"))
			.mockResolvedValueOnce("/repo");
		useUi.setState({
			modal: { name: "new-session", props: { workspaceId: "ws1", useWorktree: true } },
		});

		render(<NewSessionDialog />);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("git exited 128");
		const submitBtn = screen.getByRole("button", { name: "创建会话" }) as HTMLButtonElement;
		expect(submitBtn.disabled).toBe(true);
		expect(mocks.createSession).not.toHaveBeenCalled();

		// Retry probe -> succeeds, clears error, and allows isolated worktree creation
		fireEvent.click(screen.getByRole("button", { name: "重试检测" }));
		await waitFor(() => expect(mocks.gitRepoRoot).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

		fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
		await waitFor(() =>
			expect(mocks.gitCreateWorktree).toHaveBeenCalledWith("/repo", expect.any(String), expect.any(Object)),
		);
		expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo/.worktrees/wt1" }));
	});
});
