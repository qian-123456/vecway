// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../../core/api";
import { ChatCtx } from "../chat/ChatContext";
import { ChatController } from "../chat/chatStore";
import { PLAN_OFF, type ApprovedStatus } from "../../../src/features/chat/plan/planStatus";
import { WorkspacePanelBar } from "./WorkspacePanelBar";

const status = (value: ApprovedStatus) => ({ ...PLAN_OFF, approved: { planFile: null, planUrl: null, title: "Approved", content: "authoritative plan", prevContent: null, version: 1, status: value, error: null } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("workspace navigation keeps Plan outside workspace tabs", () => {
	it("never adds a Plan tab to WorkspacePanelBar even when a plan exists", () => {
		const request = vi.spyOn(apiModule, "api").mockResolvedValue({});
		const controller = new ChatController("fixture-context");
		controller.store.setState({ cstate: { planMode: true, planStatus: status("completed") } });
		render(
			<ChatCtx.Provider value={{ controller, openActions() {}, openStat() {} }}>
				<WorkspacePanelBar sessionId={controller.id} current="files" />
			</ChatCtx.Provider>,
		);
		expect(screen.queryByRole("link", { name: "计划" })).toBeNull();
		expect(screen.getByRole("link", { name: "文件" }).getAttribute("aria-current")).toBe("page");
		expect(request).not.toHaveBeenCalled();
		controller.dispose();
	});
});
