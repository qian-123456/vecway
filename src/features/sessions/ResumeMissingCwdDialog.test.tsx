// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";

const mocks = vi.hoisted(() => ({
	closeModal: vi.fn(),
	rejectResume: vi.fn(),
	resumeSession: vi.fn(),
	relocateWorkspace: vi.fn(),
	suppressRelocationToast: vi.fn(),
	open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("../../components/Modal", () => ({
	Modal: ({ children }: PropsWithChildren) => <div role="dialog">{children}</div>,
}));
vi.mock("../../lib/ipc", () => ({
	gitListBranches: vi.fn(async () => ["main"]),
	gitCreateWorktree: vi.fn(),
	relocateWorkspace: mocks.relocateWorkspace,
	relocateSession: vi.fn(),
}));
vi.mock("../../lib/ensureLive", () => ({
	RESUME_MISSING_CWD_MODAL: "resume-missing-cwd",
	rejectResume: mocks.rejectResume,
	resolveResume: vi.fn(),
	resumeSession: mocks.resumeSession,
	cwdMissingPath: () => null,
	suppressRelocationToast: mocks.suppressRelocationToast,
}));
vi.mock("../../stores/sessions", async () => {
	const { create } = await import("zustand");
	return { useSessions: create(() => ({ load: vi.fn(async () => {}) })) };
});
vi.mock("../../stores/worktrees", async () => {
	const { create } = await import("zustand");
	return { useWorktrees: create(() => ({ refresh: vi.fn(async () => {}) })) };
});
vi.mock("../../stores/ui", async () => {
	const { create } = await import("zustand");
	return {
		useUi: create(() => ({
			modal: null,
			closeModal: mocks.closeModal,
		})),
	};
});

import { useUi } from "../../stores/ui";
import { ResumeMissingCwdDialog } from "./ResumeMissingCwdDialog";

describe("ResumeMissingCwdDialog project migration opt-in", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.open.mockResolvedValue("/new/folder");
		mocks.resumeSession.mockResolvedValue(undefined);
		mocks.relocateWorkspace.mockResolvedValue(undefined);
		useUi.setState({
			modal: {
				name: "resume-missing-cwd",
				props: {
					sessionId: "s1",
					missingCwd: "/old/folder",
					workspaceId: "ws1",
					workspaceName: "DemoRepo",
					workspaceMissing: true,
				},
			},
		});
	});
	afterEach(cleanup);

	it("defaults relocateWholeProject to unchecked even when workspaceMissing=true and updates primary label when checked", async () => {
		render(<ResumeMissingCwdDialog />);
		const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
		expect(checkbox.checked).toBe(false);

		// Primary button starts as "继续"
		expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();

		// Checking whole-project migration switches button label to "迁移整个项目并继续"
		fireEvent.click(checkbox);
		expect(checkbox.checked).toBe(true);
		expect(screen.getByRole("button", { name: "迁移整个项目并继续" })).toBeTruthy();

		// Uncheck -> only resume single session without relocating whole workspace
		fireEvent.click(checkbox);
		fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
		await screen.findByText(/\/new\/folder/);
		fireEvent.click(screen.getByRole("button", { name: "继续" }));
		await waitFor(() => expect(mocks.resumeSession).toHaveBeenCalledWith("s1", "/new/folder"));
		expect(mocks.relocateWorkspace).not.toHaveBeenCalled();
	});
});
