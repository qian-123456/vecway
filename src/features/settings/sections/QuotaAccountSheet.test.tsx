// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { confirmDialog, oauthLogout, oauthLoginProviders } = vi.hoisted(() => ({
	confirmDialog: vi.fn(),
	oauthLogout: vi.fn(),
	oauthLoginProviders: vi.fn(),
}));

vi.mock("../../../lib/dialogs", () => ({ confirmDialog, errMsg: (e: unknown) => String(e) }));
vi.mock("../../../lib/ipc", () => ({ oauthLogout, oauthLoginProviders }));
vi.mock("../../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../providers/OauthLoginDialog", () => ({ OauthLoginDialog: () => null }));
vi.mock("../../providers/ProviderDialog", () => ({ ProviderDialog: () => null }));
vi.mock("../../providers/store", () => ({
	useProviders: (sel: (s: unknown) => unknown) =>
		sel({
			rows: [],
			loaded: true,
			load: vi.fn(),
		}),
}));
vi.mock("./ProviderBrandLogo", () => ({ ProviderBrandLogo: () => null }));

import { QuotaAccountSheet, QuotaBar, type AccountSheetProvider } from "./QuotaAccountSheet";

const provider = {
	providerId: "anthropic",
	brand: { name: "Anthropic", badge: "OAuth", badgeClass: "", color: "#000", progressColor: "#000" },
	reports: [
		{
			fetchedAt: 1,
			limits: [],
			metadata: { email: "a@b.com", planType: "Max" },
		},
	],
	unmetered: [],
} as unknown as AccountSheetProvider;

function setup(onRefresh = vi.fn(), onClose = vi.fn()) {
	render(
		<QuotaAccountSheet
			isOpen
			onClose={onClose}
			provider={provider}
			now={1000}
			refreshing={false}
			onRefresh={onRefresh}
		/>,
	);
	return { onRefresh, onClose };
}

describe("QuotaAccountSheet", () => {
	beforeEach(() => {
		oauthLoginProviders.mockResolvedValue([{ id: "anthropic", available: true }]);
		oauthLogout.mockResolvedValue(1);
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders email and plan type", () => {
		setup();
		expect(screen.getByText("a@b.com")).toBeTruthy();
		expect(screen.getByText("Max")).toBeTruthy();
	});

	it("logs out after confirm and refreshes", async () => {
		confirmDialog.mockResolvedValue(true);
		const { onRefresh } = setup();
		fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
		expect(confirmDialog).toHaveBeenCalled();
		await waitFor(() => expect(oauthLogout).toHaveBeenCalledWith("anthropic", "a@b.com", undefined));
		await waitFor(() => expect(onRefresh).toHaveBeenCalled());
	});

	it("does nothing when canceled", async () => {
		confirmDialog.mockResolvedValue(false);
		setup();
		fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
		await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
		expect(oauthLogout).not.toHaveBeenCalled();
	});

	it("shows 添加账号 in footer", async () => {
		setup();
		expect(await screen.findByRole("button", { name: "添加账号" })).toBeTruthy();
	});
	it("clears all provider credentials only after explicit confirmation", async () => {
		confirmDialog.mockResolvedValue(true);
		const onClose = vi.fn();
		const onRefresh = vi.fn();
		render(
			<QuotaAccountSheet
				isOpen
				onClose={onClose}
				provider={provider}
				now={1000}
				refreshing={false}
				onRefresh={onRefresh}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "清除全部授权" }));
		await waitFor(() => expect(oauthLogout).toHaveBeenCalledWith("anthropic", null, null, true));
		expect(onClose).toHaveBeenCalled();
		expect(onRefresh).toHaveBeenCalled();
	});

	it("does not clear all credentials when the user cancels", async () => {
		confirmDialog.mockResolvedValue(false);
		setup();
		fireEvent.click(screen.getByRole("button", { name: "清除全部授权" }));
		await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
		expect(oauthLogout).not.toHaveBeenCalled();
	});


	it("handles multi-account logout without closing sheet until last account", async () => {
		confirmDialog.mockResolvedValue(true);
		const multiProvider = {
			...provider,
			reports: [
				{ fetchedAt: 1, limits: [], metadata: { email: "acc1@b.com", planType: "Pro" } },
				{ fetchedAt: 1, limits: [], metadata: { email: "acc2@b.com", planType: "Max" } },
			],
		} as unknown as AccountSheetProvider;
		const onRefresh = vi.fn();
		const onClose = vi.fn();
		render(
			<QuotaAccountSheet
				isOpen
				onClose={onClose}
				provider={multiProvider}
				now={1000}
				refreshing={false}
				onRefresh={onRefresh}
			/>,
		);
		const buttons = screen.getAllByRole("button", { name: "退出登录" });
		expect(buttons).toHaveLength(2);
		fireEvent.click(buttons[0]);
		await waitFor(() => expect(oauthLogout).toHaveBeenCalledWith("anthropic", "acc1@b.com", undefined));
		expect(onClose).not.toHaveBeenCalled();
		expect(onRefresh).toHaveBeenCalled();
	});
});

describe("QuotaBar", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders an empty full-width contrast track without a fill stub at 0%", () => {
		const { container } = render(
			<QuotaBar
				label="7 天"
				usedPct={0}
				statusText="已用 0.0%"
				caption="6 天 23 小时后重置"
				tone="neutral"
				brandColor="#10A37F"
			/>,
		);
		const track = container.querySelector(".h-1.w-full");
		expect(track).toBeTruthy();
		expect(track?.className).toContain("bg-[var(--track-bg)]");
		expect(track?.children).toHaveLength(0);
	});

	it("preserves a 1.5% minimum pill for small positive usage and clamps over 100%", () => {
		const { container, rerender } = render(
			<QuotaBar
				label="7 天"
				usedPct={0.4}
				statusText="已用 0.4%"
				tone="neutral"
				brandColor="#10A37F"
			/>,
		);
		const fill = container.querySelector(".h-1.w-full > div") as HTMLElement | null;
		expect(fill).toBeTruthy();
		expect(fill?.style.width).toBe("1.5%");

		rerender(
			<QuotaBar
				label="5 小时"
				usedPct={120}
				statusText="100% 耗尽"
				tone="rose"
				brandColor="#10A37F"
			/>,
		);
		const clamped = container.querySelector(".h-1.w-full > div") as HTMLElement | null;
		expect(clamped?.style.width).toBe("100%");
	});
});
