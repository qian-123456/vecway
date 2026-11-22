// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();
const navPushMock = vi.fn();
const navReplaceMock = vi.fn();
const createSessionMock = vi.fn();

vi.mock("../../core/api", () => ({
	api: (...args: unknown[]) => apiMock(...args),
	errorMessage: (e: unknown) => String(e),
}));

vi.mock("../../core/nav", () => ({
	nav: {
		push: (...args: unknown[]) => navPushMock(...args),
		replace: (...args: unknown[]) => navReplaceMock(...args),
		pushLayer: () => () => {},
	},
	paths: {
		chat: (id: string) => `/s/${id}`,
		files: (id: string) => `/s/${id}/files`,
		git: (id: string) => `/s/${id}/git`,
		terminal: (id: string) => `/s/${id}/terminal`,
		sidechat: (id: string) => `/s/${id}/sidechat`,
		services: (id: string) => `/s/${id}/services`,
		plan: (id: string) => `/s/${id}/plan`,
		search: () => "/search",
		schedules: () => "/schedules",
		ideas: () => "/ideas",
		inbox: () => "/inbox",
		quota: () => "/quota",
		settings: () => "/settings",
	},
}));

vi.mock("../../core/stores/sessions", () => ({
	useSessions: Object.assign(
		(selector: (s: { list: unknown[]; byId: Record<string, unknown> }) => unknown) =>
			selector({ list: [], byId: {} }),
		{
			getState: () => ({
				createSession: (...args: unknown[]) => createSessionMock(...args),
				refresh: vi.fn().mockResolvedValue([]),
				list: [],
				byId: {},
			}),
		},
	),
}));

import { HomePage } from "./HomePage";
import { MenuSheet } from "./MenuSheet";
import { useTree } from "./treeStore";

beforeEach(() => {
	vi.clearAllMocks();
	useTree.setState({ data: null, error: null, loading: false, mode: "code", open: {}, expanded: {} });
	createSessionMock.mockResolvedValue({ id: "mobile-draft-1" });
	apiMock.mockImplementation(async (_method: string, path: string) => {
		if (path === "/left/dirs") return { dirs: [{ path: "/proj", label: "proj", kind: "workspace", mode: "code" }] };
		if (path.startsWith("/left/sessions")) {
			return { pinned: [], globalGroup: null, workspaceGroups: [], unassignedGroups: [], deletedSessions: [], archived: [] };
		}
		if (path === "/left/todos") return { todos: [] };
		return {};
	});
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
describe("Session surface DOM accessibility (not layout measurement)", () => {
 it("exposes the Home composer and its primary actions", () => {
  render(<HomePage route={{ name: "home", path: "/", params: {}, query: {} }} />);
  expect(screen.getByRole("textbox", { name: "消息输入框" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "语音输入" })).toBeTruthy();
 });

	it("exposes a modal navigation dialog that closes on Escape", () => {
		const onClose = vi.fn();
		render(<MenuSheet open onClose={onClose} />);
		expect(screen.getByRole("dialog", { name: "导航" }).getAttribute("aria-modal")).toBe("true");
		fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("opens Home HeaderMenu from the top-right tools button, disables sidechat, and navigates via draft creation", async () => {
		render(<HomePage route={{ name: "home", path: "/", params: {}, query: {} }} />);
		const toolsBtn = screen.getByRole("button", { name: "工具菜单" });
		fireEvent.click(toolsBtn);

		const dialog = screen.getByRole("dialog", { name: "工具" });
		expect(dialog).toBeTruthy();

		const sidechatBtn = screen.getByRole("button", { name: /辅助对话/ }) as HTMLButtonElement;
		expect(sidechatBtn.disabled).toBe(true);
		expect(screen.getByText("发送第一条消息后可用")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /文件/ }));
		await waitFor(() => expect(createSessionMock).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(navPushMock).toHaveBeenCalledWith("/s/mobile-draft-1/files"));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "工具" })).toBeNull());
	});

	it("opens directory picker from + -> 在项目中工作 without creating a draft", async () => {
		render(<HomePage route={{ name: "home", path: "/", params: {}, query: {} }} />);
		fireEvent.click(screen.getByRole("button", { name: "添加" }));
		fireEvent.click(screen.getByRole("button", { name: /在项目中工作/ }));
		expect(await screen.findByRole("dialog", { name: "选择当前目录" })).toBeTruthy();
		expect(createSessionMock).not.toHaveBeenCalled();
	});
});
