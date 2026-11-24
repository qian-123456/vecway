// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	confirm: vi.fn(),
	toast: vi.fn(),
	refreshAll: vi.fn(),
}));

vi.mock("../../core/api", () => ({
	api: mocks.api,
	errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("../../ui", () => ({
	confirm: mocks.confirm,
	toast: mocks.toast,
}));
vi.mock("./treeStore", () => ({
	refreshAll: mocks.refreshAll,
	useTree: { getState: () => ({ load: vi.fn() }) },
}));

import { batchArchive } from "./actions";

describe("mobile batchArchive draft protection and undo", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.api.mockResolvedValue({});
		mocks.confirm.mockResolvedValue(true);
		mocks.refreshAll.mockResolvedValue(undefined);
	});

	it("skips draft sessions, archives only real sessions, and offers 5s Undo", async () => {
		await batchArchive("Demo", [
			{ id: "mobile-draft-1", archived: false } as never,
			{ id: "real-1", archived: false } as never,
			{ id: "real-2", archived: false } as never,
		]);

		expect(mocks.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.stringContaining("保留 1 个未发送草稿"),
				danger: true,
			}),
		);
		expect(mocks.api).toHaveBeenCalledTimes(2);
		expect(mocks.api).toHaveBeenCalledWith("PATCH", "/left/sessions/real-1", { archived: true });
		expect(mocks.api).toHaveBeenCalledWith("PATCH", "/left/sessions/real-2", { archived: true });
		expect(mocks.api).not.toHaveBeenCalledWith("POST", "/left/drafts/mobile-draft-1/discard");

		const [toastMsg, toastOpts] = mocks.toast.mock.calls[0];
		expect(toastMsg).toContain("已归档 2 个会话");
		expect(toastMsg).toContain("已保留 1 个草稿");
		expect(toastOpts.ms).toBe(5000);
		expect(toastOpts.action?.label).toBe("撤销");

		// Trigger undo action
		await toastOpts.action.onClick();
		expect(mocks.api).toHaveBeenCalledWith("PATCH", "/left/sessions/real-1", { archived: false });
		expect(mocks.api).toHaveBeenCalledWith("PATCH", "/left/sessions/real-2", { archived: false });
	});

	it("does not prompt or discard when group only contains drafts", async () => {
		await batchArchive("DraftsOnly", [{ id: "mobile-draft-9", archived: false } as never]);
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(mocks.api).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith("该分组仅包含 1 个未发送草稿，已保留");
	});
});
