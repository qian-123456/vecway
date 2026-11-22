// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
vi.mock("../../core/nav", () => ({
	nav: { push: (...a: unknown[]) => pushMock(...a), pushLayer: () => () => {} },
	paths: {
		search: () => "/search",
		schedules: () => "/schedules",
		ideas: () => "/ideas",
		inbox: () => "/inbox",
		quota: () => "/quota",
		settings: () => "/settings",
		chat: (id: string) => `/s/${id}`,
	},
}));

vi.mock("../../core/api", () => ({
	api: vi.fn().mockResolvedValue({ dirs: [] }),
	errorMessage: (e: unknown) => String(e),
}));

vi.mock("../../core/stores/sessions", () => ({
	useSessions: Object.assign(
		(selector: (s: { list: unknown[]; byId: Record<string, unknown> }) => unknown) =>
			selector({ list: [], byId: {} }),
		{
			getState: () => ({
				list: [],
				byId: {},
				refresh: vi.fn().mockResolvedValue([]),
			}),
		},
	),
}));

import { MenuSheet } from "./MenuSheet";

beforeEach(() => {
	vi.clearAllMocks();
	delete window.__VECWAY_NATIVE__;
});

afterEach(() => {
	cleanup();
	delete window.__VECWAY_NATIVE__;
});
describe("MenuSheet (Left Navigation Sheet)", () => {
	it("renders required Top, Middle, and Bottom sections and excludes irrelevant Gemini items", () => {
		const onClose = vi.fn();
		const onNewSession = vi.fn();

		render(<MenuSheet open onClose={onClose} onNewSession={onNewSession} />);

		// 1. Top section
		const newBtn = screen.getByRole("button", { name: /发起新对话/i });
		expect(newBtn).not.toBeNull();
		fireEvent.click(newBtn);
		expect(onNewSession).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();

		const searchBtn = screen.getByRole("button", { name: /搜索会话/i });
		expect(searchBtn).not.toBeNull();
		fireEvent.click(searchBtn);
		expect(pushMock).toHaveBeenCalledWith("/search");

		const schedulesBtn = screen.getByRole("button", { name: /自动化/i });
		expect(schedulesBtn).not.toBeNull();
		fireEvent.click(schedulesBtn);
		expect(pushMock).toHaveBeenCalledWith("/schedules");

		fireEvent.click(screen.getByRole("button", { name: "灵感收件箱" }));
		expect(pushMock).toHaveBeenCalledWith("/ideas");

		// 2. Middle section: Desktop-parity Projects header with filter menu ("按项目 / 按时间")
		const filterBtn = screen.getByRole("button", { name: "切换视图" });
		expect(filterBtn).not.toBeNull();
		fireEvent.click(filterBtn);
		const projectItem = screen.getByRole("menuitemradio", { name: "按项目" });
		const timeItem = screen.getByRole("menuitemradio", { name: "按时间" });
		expect(projectItem.getAttribute("aria-checked")).toBe("true");
		expect(timeItem.getAttribute("aria-checked")).toBe("false");

		fireEvent.click(timeItem);
		expect(screen.getByText("全部对话")).not.toBeNull();
		const inboxBtn = screen.getByRole("button", { name: "收件箱" });
		fireEvent.click(inboxBtn);
		expect(pushMock).toHaveBeenCalledWith("/inbox");

		const quotaBtn = screen.getByRole("button", { name: /订阅与配额/i });
		expect(quotaBtn).not.toBeNull();
		fireEvent.click(quotaBtn);
		expect(pushMock).toHaveBeenCalledWith("/quota");

		const settingsBtn = screen.getByRole("button", { name: /设置/i });
		expect(settingsBtn).not.toBeNull();
		fireEvent.click(settingsBtn);
		expect(pushMock).toHaveBeenCalledWith("/settings");

		// 4. Remove irrelevant Gemini items: 库, 学生, 自定义, 视频, 笔记本
		expect(screen.queryByText(/库/)).toBeNull();
		expect(screen.queryByText(/学生/)).toBeNull();
		expect(screen.queryByText(/自定义/)).toBeNull();
		expect(screen.queryByText(/视频/)).toBeNull();
		expect(screen.queryByText(/笔记本/)).toBeNull();
	});

	it("leaves right scrim visible with an 85vw/340px drawer and uses a compact desktop-style space menu", () => {
		const onClose = vi.fn();
		render(<MenuSheet open onClose={onClose} />);
		const drawer = screen.getByRole("dialog", { name: "导航" });
		expect(drawer.className).toContain("w-[85vw]");
		expect(drawer.className).toContain("max-w-[340px]");
		const trigger = screen.getByRole("button", { name: /代码空间/ });
		fireEvent.click(trigger);
		expect(screen.getByRole("menu", { name: "切换空间" })).toBeTruthy();
		expect(screen.getByRole("menuitemradio", { name: "代码" }).getAttribute("aria-checked")).toBe("true");
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("menu", { name: "切换空间" })).toBeNull();
		expect(onClose).not.toHaveBeenCalled();
		const bottom = screen.getByRole("contentinfo", { name: "更多入口" });
		expect(bottom.contains(screen.getByRole("button", { name: "设置" }))).toBe(true);
		expect(bottom.contains(screen.getByRole("button", { name: "订阅与配额" }))).toBe(true);
		expect(bottom.contains(screen.getByRole("button", { name: "收件箱" }))).toBe(false);
	});

	it("cancels interrupted and multi-touch swipes without closing navigation", () => {
		const onClose = vi.fn();
		render(<MenuSheet open onClose={onClose} />);
		const drawer = screen.getByRole("dialog", { name: "导航" });
		fireEvent.touchStart(drawer, { touches: [{ clientX: 300, clientY: 100 }] });
		fireEvent.touchMove(drawer, { touches: [{ clientX: 100, clientY: 110 }] });
		fireEvent.touchCancel(drawer);
		expect(onClose).not.toHaveBeenCalled();
		expect(drawer.style.transform).toBe("");
		fireEvent.touchStart(drawer, { touches: [{ clientX: 300, clientY: 100 }] });
		fireEvent.touchMove(drawer, { touches: [{ clientX: 100, clientY: 110 }] });
		fireEvent.touchMove(drawer, { touches: [{ clientX: 100, clientY: 110 }, { clientX: 200, clientY: 110 }] });
		fireEvent.touchEnd(drawer);
		expect(onClose).not.toHaveBeenCalled();
		expect(drawer.style.transform).toBe("");
	});

	it("offers a one-tap switch back to LAN in native mode when currently on tunnel", async () => {
		const lanStatus = {
			paired: true,
			activeChannel: "lan_tls" as const,
			preferredChannel: "lan_tls" as const,
			activeUrl: "https://192.168.1.10:7790",
			certSha256: "AA:BB",
			candidates: { lanTls: "https://192.168.1.10:7790", tunnel: "https://omp.example.com" },
		};
		const switchChannel = vi.fn(async () => lanStatus);
		window.__VECWAY_NATIVE__ = {
			platform: "ios",
			appVersion: "1.0.0",
			httpRequest: vi.fn(),
			openSse: vi.fn(() => vi.fn()),
			getConnectionStatus: vi.fn(async () => ({
				...lanStatus,
				activeChannel: "tunnel" as const,
				preferredChannel: "tunnel" as const,
				activeUrl: "https://omp.example.com",
			})),
			openPairScanner: vi.fn(),
			updateEndpoints: vi.fn(),
			reprobeConnection: vi.fn(),
			switchChannel,
			unpair: vi.fn(),
		};

		render(<MenuSheet open onClose={vi.fn()} />);
		const quickLanBtn = await screen.findByRole("button", { name: "切回局域网" });
		await act(async () => {
			fireEvent.click(quickLanBtn);
		});
		await waitFor(() => expect(switchChannel).toHaveBeenCalledWith("lan_tls"));
		expect(screen.queryByRole("button", { name: "切回局域网" })).toBeNull();
	});
});
