// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePrefs } from "../../core/stores/prefs";
import type { NativeBridge, NativePushStatus } from "../../core/nativeBridge";
import { NotifySheet } from "./sheets/NotifySheet";

afterEach(() => {
	cleanup();
	delete window.__VECWAY_NATIVE__;
	vi.unstubAllGlobals();
});

describe("NotifySheet", () => {
	it("disables push over insecure http but keeps the in-page fallbacks working", async () => {
		vi.stubGlobal("isSecureContext", false);
		await act(async () => {
			render(<NotifySheet open onClose={() => {}} />);
		});
		const push = screen.getByRole("switch", { name: "推送通知" }) as HTMLButtonElement;
		expect(push.disabled).toBe(true);
		expect(screen.getByText("需要 https 连接")).toBeDefined();
		expect(screen.queryByText("发送测试通知")).toBeNull();

		const sound = screen.getByRole("switch", { name: "提示音" }) as HTMLButtonElement;
		expect(sound.disabled).toBe(false);
		const before = usePrefs.getState().notifySound;
		fireEvent.click(sound);
		expect(usePrefs.getState().notifySound).toBe(!before);
	});
});

describe("NotifySheet native mode", () => {
	it("hides Safari Home Screen hint and browser https errors in native mode when push is unsupported", async () => {
		vi.stubGlobal("isSecureContext", false);
		const getStatus = vi.fn(
			async (): Promise<NativePushStatus> => ({
				supported: false,
				permission: "default",
				registered: false,
				reason: "当前版本暂未配置 APNs 推送",
			}),
		);
		window.__VECWAY_NATIVE__ = {
			platform: "ios",
			appVersion: "0.2.0",
			httpRequest: vi.fn(),
			openSse: vi.fn(() => vi.fn()),
			getConnectionStatus: vi.fn(),
			openPairScanner: vi.fn(),
			updateEndpoints: vi.fn(),
			reprobeConnection: vi.fn(),
			unpair: vi.fn(),
			push: {
				getStatus,
				enable: vi.fn(async () => {}),
				disable: vi.fn(async () => {}),
			},
		} satisfies NativeBridge;

		await act(async () => {
			render(<NotifySheet open onClose={() => {}} />);
		});

		expect(getStatus).toHaveBeenCalledTimes(1);
		const push = screen.getByRole("switch", { name: "推送通知" }) as HTMLButtonElement;
		expect(push.disabled).toBe(true);
		expect(screen.getByText("当前版本暂未配置 APNs 推送")).toBeDefined();
		expect(screen.queryByText(/添加到主屏幕/)).toBeNull();
		expect(screen.queryByText("需要 https 连接")).toBeNull();
		expect(screen.queryByText("标题闪烁")).toBeNull();
	});

	it("delegates enable, disable, and test push to bridge.push when supported", async () => {
		let registered = false;
		const getStatus = vi.fn(
			async (): Promise<NativePushStatus> => ({
				supported: true,
				permission: "granted",
				registered,
			}),
		);
		const enable = vi.fn(async () => {
			registered = true;
		});
		const disable = vi.fn(async () => {
			registered = false;
		});
		const sendTest = vi.fn(async () => {});
		window.__VECWAY_NATIVE__ = {
			platform: "ios",
			appVersion: "0.2.0",
			httpRequest: vi.fn(),
			openSse: vi.fn(() => vi.fn()),
			getConnectionStatus: vi.fn(),
			openPairScanner: vi.fn(),
			updateEndpoints: vi.fn(),
			reprobeConnection: vi.fn(),
			unpair: vi.fn(),
			push: { getStatus, enable, disable, sendTest },
		};

		await act(async () => {
			render(<NotifySheet open onClose={() => {}} />);
		});

		const push = screen.getByRole("switch", { name: "推送通知" }) as HTMLButtonElement;
		expect(push.disabled).toBe(false);

		await act(async () => {
			fireEvent.click(push);
		});
		expect(enable).toHaveBeenCalledTimes(1);

		const testBtn = screen.getByRole("button", { name: "发送测试通知" });
		await act(async () => {
			fireEvent.click(testBtn);
		});
		expect(sendTest).toHaveBeenCalledTimes(1);

		await act(async () => {
			fireEvent.click(push);
		});
		expect(disable).toHaveBeenCalledTimes(1);
	});
});
