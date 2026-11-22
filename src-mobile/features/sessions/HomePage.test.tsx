// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();
const uploadMock = vi.fn();
const createSessionMock = vi.fn();
const replaceMock = vi.fn();

vi.mock("../../core/api", () => ({
	api: (...a: unknown[]) => apiMock(...a),
	upload: (...a: unknown[]) => uploadMock(...a),
	errorMessage: (e: unknown) => String((e as Error)?.message ?? e),
}));
vi.mock("../../core/nav", () => ({
	nav: { push: vi.fn(), replace: (...a: unknown[]) => replaceMock(...a), pushLayer: () => () => {} },
	paths: { chat: (id: string) => `/s/${id}`, search: () => "/search", schedules: () => "/schedules", inbox: () => "/inbox", quota: () => "/quota", settings: () => "/settings" },
}));
vi.mock("../../core/stores/sessions", () => ({
	useSessions: Object.assign(
		(selector: (s: { list: unknown[]; byId: Record<string, unknown> }) => unknown) =>
			selector({ list: [], byId: {} }),
		{
			getState: () => ({
				createSession: createSessionMock,
				refresh: vi.fn().mockResolvedValue([]),
				list: [],
				byId: {},
			}),
		},
	),
}));

import { HomePage } from "./HomePage";
import { draftBook, takeFirstSend } from "../chat/lib/drafts";
import { useRightDrawer } from "../panels/rightDrawerStore";

vi.mock("../chat/components/useVoiceInput", () => ({
	useVoiceInput: ({ onTranscribed }: { onTranscribed: (text: string) => void }) => ({ recording: false, transcribing: false, toggleRecording: async () => onTranscribed("语音转写内容") }),
}));

const typeMessage = async (text: string) => {
	const input = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
	await act(async () => {
		fireEvent.input(input, { target: { value: text } });
		// iOS 15 is part of this app's supported target and lacks Promise.withResolvers.
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});
	return input;
};

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
	vi.stubGlobal("URL", class extends URL {
		static createObjectURL(file: File) { return `blob:${file.name}`; }
		static revokeObjectURL = vi.fn();
	});
	useRightDrawer.setState({ open: false, sessionId: null, tabBySession: {}, visitedBySession: {}, pendingSidechat: null, pendingMain: null });
	uploadMock.mockResolvedValue({ path: "/uploads/doc.txt" });
	apiMock.mockImplementation(async (_m: string, path: string) => {
		if (path === "/left/dirs") {
			return {
				dirs: [
					{ path: "/project/workspace", label: "workspace", kind: "workspace", mode: "code", workspaceId: "w1" },
				],
			};
		}
		if (path === "/left/sessions") {
			return { pinned: [], workspaceGroups: [], unassignedGroups: [], deletedSessions: [], archived: [] };
		}
		if (path === "/left/todos") {
			return { todos: [] };
		}
		if (path.includes("/prompt-ex")) {
			return { sessionId: "real-session-123" };
		}
		return {};
	});
	createSessionMock.mockResolvedValue({ id: "mobile-draft-1", mode: "code", cwd: "/project/workspace" });
});

afterEach(() => {
	cleanup();
 vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("HomePage", () => {
	it("renders a minimal blank home with directory selector and desktop-style composer, without greeting/chips/fake context or eager tree sync", () => {
		render(<HomePage route={{ name: "home", path: "/", params: {}, query: {} }} />);

		// Blank minimal canvas: no duplicate greeting headline, no quick prompts, no fake 0% context
		expect(screen.queryByRole("heading", { name: "今天想做点什么？" })).toBeNull();
		expect(screen.queryByText("梳理当前仓库的关键结构")).toBeNull();
		expect(screen.queryByRole("button", { name: /上下文用量/ })).toBeNull();

		// No user name or 聊天/任务 switch
		expect(screen.queryByText(/用户|User|Admin/i)).toBeNull();
		expect(screen.queryByRole("tab", { name: "会话" })).toBeNull();
		expect(screen.queryByRole("tab", { name: "待办" })).toBeNull();
		expect(screen.queryByText("聊天/任务")).toBeNull();

		// Desktop-style 2-row composer exists with +, mic, and textarea
		expect(screen.getByRole("button", { name: "添加" })).not.toBeNull();
		expect(screen.getByRole("button", { name: "语音输入" })).not.toBeNull();
		expect(screen.getByPlaceholderText("今天想做点什么？")).not.toBeNull();

		// Performance: HomePage mount does not eagerly sync session tree or todos
		expect(apiMock.mock.calls.some((call) => String(call[1]).includes("/left/sessions"))).toBe(false);
		expect(apiMock.mock.calls.some((call) => String(call[1]).includes("/todos"))).toBe(false);
	});
	it("keeps the mic available while typing and activates the draft route with the first prompt queued", async () => {
		render(<HomePage route={{ name: "home", path: "/", params: {}, query: {} }} />);
		await typeMessage("帮我编写单元测试");
		expect(screen.getByRole("button", { name: "语音输入" })).toBeTruthy();
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "发送" })); });
		expect(createSessionMock).toHaveBeenCalledWith({ cwd: "/project/workspace", mode: "code" });
		expect(replaceMock).toHaveBeenCalledWith("/s/mobile-draft-1");
		expect(takeFirstSend("mobile-draft-1")).toBe("帮我编写单元测试");
		expect(apiMock.mock.calls.some((call) => String(call[1]).includes("/prompt-ex"))).toBe(false);
	});

	it("inserts voice transcription at the caret without creating or sending a session", async () => {
		render(<HomePage route={{ name: "home", path: "/", params: {}, query: {} }} />);
		const input = await typeMessage("前文后文");
		input.setSelectionRange(2, 2);
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "语音输入" })); });
		expect(input.value).toBe("前文 语音转写内容后文");
		expect(createSessionMock).not.toHaveBeenCalled();
		expect(replaceMock).not.toHaveBeenCalled();
	});

	it("retains the text on creation failure instead of entering a missing-session route", async () => {
		createSessionMock.mockRejectedValueOnce(new Error("离线"));
		render(<HomePage route={{ name: "home", path: "/", params: {}, query: {} }} />);
		const input = await typeMessage("保留这条消息");
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "发送" })); });
		expect(input.value).toBe("保留这条消息");
		expect(replaceMock).not.toHaveBeenCalled();
	});

	it.each([false, true])("selects a directory without creating, then revalidates availability %s before send", async (unavailable) => {
		const first = { path: "/project/workspace", label: "workspace", kind: "workspace", mode: "code" };
		const selected = { path: "/external/feature", label: "feature worktree", kind: "worktree", mode: "code" };
		let available = true;
		apiMock.mockImplementation(async (_method: string, path: string) => {
			if (path === "/left/dirs") return { dirs: available ? [first, selected] : [first], homeDir: "/project" };
			if (path.startsWith("/left/sessions")) return { pinned: [], globalGroup: null, workspaceGroups: [], unassignedGroups: [], deletedSessions: [], archived: [] };
			if (path === "/todos") return [];
			return {};
		});
		render(<HomePage route={{ name: "home", path: "/", params: {}, query: {} }} />);
		fireEvent.click(await screen.findByRole("button", { name: "当前目录：/project/workspace，点击切换" }));
		fireEvent.click(await screen.findByRole("radio", { name: /feature worktree/ }));
		fireEvent.click(screen.getByRole("button", { name: "使用此目录" }));
		expect(createSessionMock).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "当前目录：/external/feature，点击切换" })).toBeTruthy();
		available = !unavailable;
		await typeMessage("选定工作树的消息");
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送" })));
		if (unavailable) {
			expect(createSessionMock).not.toHaveBeenCalled();
			expect(replaceMock).not.toHaveBeenCalled();
			expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe("选定工作树的消息");
		} else {
			await waitFor(() => expect(createSessionMock).toHaveBeenCalledWith({ cwd: selected.path, mode: "code" }));
			expect(takeFirstSend("mobile-draft-1")).toBe("选定工作树的消息");
		}
	});

	it("stages images in place on Home with numbered thumbnails and supports image-only send without leaving early", async () => {
		const { container } = render(<HomePage route={{ name: "home", path: "/", params: {}, query: {} }} />);
		const galleryInput = container.querySelector('input[type="file"][accept="image/*"][multiple]') as HTMLInputElement;
		expect(galleryInput).toBeTruthy();

		const img1 = new File(["png1"], "one.png", { type: "image/png" });
		const img2 = new File(["png2"], "two.png", { type: "image/png" });
		await act(async () => {
			fireEvent.change(galleryInput, { target: { files: [img1, img2] } });
		});

		// Stays on Home without eagerly creating a draft or navigating
		expect(createSessionMock).not.toHaveBeenCalled();
		expect(replaceMock).not.toHaveBeenCalled();
		expect(await screen.findByRole("button", { name: "预览图片 1" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "预览图片 2" })).toBeTruthy();
		expect(screen.getByText("1")).toBeTruthy();
		expect(screen.getByText("2")).toBeTruthy();
		expect(screen.queryByText("one.png")).toBeNull();

		// Removing second image leaves first ready; send button enables for image-only send
		const removeBtns = screen.getAllByRole("button", { name: "移除附件" });
		expect(removeBtns).toHaveLength(2);
		fireEvent.click(removeBtns[1]);
		expect(screen.queryByRole("button", { name: "预览图片 2" })).toBeNull();

		const sendBtn = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
		await waitFor(() => {
			expect(screen.queryByRole("status", { name: "加载中" })).toBeNull();
			expect(sendBtn.disabled).toBe(false);
		});
		await act(async () => {
			fireEvent.click(sendBtn);
		});

		expect(createSessionMock).toHaveBeenCalledWith({ cwd: "/project/workspace", mode: "code" });
		expect(replaceMock).toHaveBeenCalledWith("/s/mobile-draft-1");
		expect(takeFirstSend("mobile-draft-1")).toBe("");
		expect(draftBook.restore("mobile-draft-1")?.atts).toHaveLength(1);
		draftBook.forget("mobile-draft-1");
	});

	it("toggles RightWorkspaceDrawer from the top-right 工作区 button", () => {
		render(<HomePage route={{ name: "home", path: "/", params: {}, query: {} }} />);
		const btn = screen.getByRole("button", { name: "工作区" });
		fireEvent.click(btn);
		expect(useRightDrawer.getState().open).toBe(true);
	});
});
