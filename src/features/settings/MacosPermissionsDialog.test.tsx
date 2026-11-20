// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "../../lib/ipc";
import type { MacosPermissionsStatus } from "../../lib/ipc";
import { useLanguageStore } from "../../stores/language";
import { findMatchingField } from "./fieldRegistry";
import { MacosPermissionsDialog } from "./MacosPermissionsDialog";

function makeStatus(
	overrides?: Partial<MacosPermissionsStatus>,
): MacosPermissionsStatus {
	return {
		supported: true,
		appPath: "/Applications/Vecway.app",
		appName: "Vecway",
		permissions: [
			{ id: "accessibility", state: "granted", canPrompt: true },
			{ id: "screenRecording", state: "denied", canPrompt: true },
			{ id: "fullDiskAccess", state: "denied", canPrompt: false },
			{ id: "localNetwork", state: "unknown", canPrompt: false },
			{ id: "developerTools", state: "unknown", canPrompt: false },
		],
		...overrides,
	};
}

beforeEach(() => {
	window.localStorage.clear();
	useLanguageStore.setState({ locale: "zh-CN" });
});

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("MacosPermissionsDialog", () => {
	it("renders all 5 permissions, app locator strip, and status badges", async () => {
		const statusSpy = vi.spyOn(ipc, "macosPermissionsStatus").mockResolvedValue(makeStatus());

		render(<MacosPermissionsDialog onClose={() => {}} />);

		await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));
		expect(screen.getByText("/Applications/Vecway.app")).toBeDefined();

		const dialog = screen.getByRole("dialog", { name: "macOS 系统权限" });
		const accRow = dialog.querySelector('[data-permission-id="accessibility"]') as HTMLElement;
		const srRow = dialog.querySelector('[data-permission-id="screenRecording"]') as HTMLElement;
		const fdaRow = dialog.querySelector('[data-permission-id="fullDiskAccess"]') as HTMLElement;
		const lnRow = dialog.querySelector('[data-permission-id="localNetwork"]') as HTMLElement;
		const devRow = dialog.querySelector('[data-permission-id="developerTools"]') as HTMLElement;

		expect(within(accRow).getByText("辅助功能")).toBeDefined();
		expect(within(accRow).getByText("已授权")).toBeDefined();

		expect(within(srRow).getByText("屏幕录制")).toBeDefined();
		expect(within(srRow).getByText("未授权")).toBeDefined();
		expect(within(srRow).getByRole("button", { name: "请求授权" })).toBeDefined();

		expect(within(fdaRow).getByText("完全磁盘访问")).toBeDefined();
		expect(within(fdaRow).getByText("未授权")).toBeDefined();

		expect(within(lnRow).getByText("本地网络")).toBeDefined();
		expect(within(lnRow).getByText("手动确认")).toBeDefined();

		expect(within(devRow).getByText("开发者工具")).toBeDefined();
		expect(within(devRow).getByText("手动确认")).toBeDefined();
	});

	it("invokes macosOpenPermissionPane with the right permission id when clicking Open Settings or Request Access", async () => {
		vi.spyOn(ipc, "macosPermissionsStatus").mockResolvedValue(makeStatus());
		const openSpy = vi.spyOn(ipc, "macosOpenPermissionPane").mockResolvedValue(undefined);

		render(<MacosPermissionsDialog onClose={() => {}} />);
		await waitFor(() => expect(screen.getByText("/Applications/Vecway.app")).toBeDefined());

		const dialog = screen.getByRole("dialog", { name: "macOS 系统权限" });
		const accRow = dialog.querySelector('[data-permission-id="accessibility"]') as HTMLElement;
		const srRow = dialog.querySelector('[data-permission-id="screenRecording"]') as HTMLElement;
		const devRow = dialog.querySelector('[data-permission-id="developerTools"]') as HTMLElement;

		fireEvent.click(within(accRow).getByRole("button", { name: /打开设置/ }));
		await waitFor(() => expect(openSpy).toHaveBeenCalledWith("accessibility"));

		fireEvent.click(within(srRow).getByRole("button", { name: "请求授权" }));
		await waitFor(() => expect(openSpy).toHaveBeenCalledWith("screenRecording", true));

		fireEvent.click(within(devRow).getByRole("button", { name: /打开设置/ }));
		await waitFor(() => expect(openSpy).toHaveBeenCalledWith("developerTools"));
	});

	it("invokes macosRevealCurrentApp when clicking Reveal in Finder", async () => {
		vi.spyOn(ipc, "macosPermissionsStatus").mockResolvedValue(makeStatus());
		const revealSpy = vi.spyOn(ipc, "macosRevealCurrentApp").mockResolvedValue(undefined);

		render(<MacosPermissionsDialog onClose={() => {}} />);
		await waitFor(() => expect(screen.getByText("/Applications/Vecway.app")).toBeDefined());

		fireEvent.click(screen.getByRole("button", { name: "在访达中显示" }));
		await waitFor(() => expect(revealSpy).toHaveBeenCalledTimes(1));
	});

	it("re-checks status on Re-check button click and on window focus", async () => {
		const initial = makeStatus();
		const updated = makeStatus({
			permissions: [
				{ id: "accessibility", state: "granted", canPrompt: true },
				{ id: "screenRecording", state: "granted", canPrompt: true },
				{ id: "fullDiskAccess", state: "granted", canPrompt: false },
				{ id: "localNetwork", state: "unknown", canPrompt: false },
				{ id: "developerTools", state: "unknown", canPrompt: false },
			],
		});

		const statusSpy = vi
			.spyOn(ipc, "macosPermissionsStatus")
			.mockResolvedValueOnce(initial)
			.mockResolvedValueOnce(initial)
			.mockResolvedValueOnce(updated);

		render(<MacosPermissionsDialog onClose={() => {}} />);
		await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));

		const dialog = screen.getByRole("dialog", { name: "macOS 系统权限" });
		const srRow = dialog.querySelector('[data-permission-id="screenRecording"]') as HTMLElement;
		expect(within(srRow).getByText("未授权")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
		await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(2));

		fireEvent(window, new Event("focus"));
		await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(3));
		await waitFor(() => expect(within(srRow).getByText("已授权")).toBeDefined());
	});

	it.each(["系统权限", "辅助功能", "accessibility", "screen recording", "验收"])(
		"registers %s search keywords in General fieldRegistry",
		(query) => {
			expect(findMatchingField("general", query)).toMatchObject({
				id: "macosPermissions",
				sectionId: "general",
			});
		},
	);
});
