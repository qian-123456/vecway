// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	RightPanelHeader,
	_clearClosedBlankSideChatDrafts,
	getClosedBlankSideChatDraft,
	restoreClosedBlankSideChatDraft,
} from "./RightPanelHeader";
import { useComposer } from "../stores/composer";
import { useSessions } from "../stores/sessions";
import { useUi } from "../stores/ui";
import { useSideChatView } from "../features/sidechat/viewStore";
import { useToasts } from "../lib/toast";
describe("RightPanelHeader blank side-chat close undo", () => {
	beforeEach(() => {
		_clearClosedBlankSideChatDrafts();
		useSideChatView.setState({ openTabs: {}, openChild: {}, usedAt: {} });
		useToasts.setState({ items: [] });
		useComposer.setState({ sideChatDrafts: {}, images: {}, files: {}, drafts: {}, annotations: {} });
		useSessions.setState({
			sessions: {
				p1: { id: "p1", title: "Parent", cwd: "/repo", status: "idle", mode: "code" } as never,
				p2: { id: "p2", title: "Other", cwd: "/repo2", status: "idle", mode: "code" } as never,
			},
		});
		useUi.setState({
			selectedSessionId: "p1",
			rightTab: "sidechat",
			openRightTabs: ["sidechat"],
			rightOpen: true,
		});
	});
	afterEach(cleanup);

	it("shows a 6s Undo toast when closing a blank side-chat tab with draft and restores it on Undo", () => {
		const blankId = useSideChatView.getState().openBlankTab("p1");
		useComposer.getState().setSideChatDraft(blankId, "Unsent important question");
		useComposer.getState().setImages(blankId, [{ id: "img-1", path: "/tmp/a.png" }]);

		render(<RightPanelHeader activeTab="sidechat" tabBadges={{} as never} />);
		const closeBtn = screen.getByRole("button", { name: /关闭标签页/ });
		fireEvent.click(closeBtn);

		// Draft cleared and tab closed
		expect(useComposer.getState().sideChatDrafts[blankId] ?? "").toBe("");
		expect(useSideChatView.getState().openTabs.p1 ?? []).toHaveLength(0);

		// Toast pushed with Undo action
		const toastItems = useToasts.getState().items;
		expect(toastItems).toHaveLength(1);
		expect(toastItems[0].action?.label).toBe("撤销");

		// Click Undo -> restores blank tab and exact draft + images
		toastItems[0].action!.onClick();
		const restoredTabs = useSideChatView.getState().openTabs.p1 ?? [];
		expect(restoredTabs).toHaveLength(1);
		const restoredId = restoredTabs[0];
		expect(useComposer.getState().sideChatDrafts[restoredId]).toBe("Unsent important question");
		expect(useComposer.getState().images[restoredId]).toEqual([{ id: "img-1", path: "/tmp/a.png" }]);
	});

	it("retains snapshot after toast dismissal/eviction, overwrites per parent, and scopes Undo UI switch to original parent", () => {
		const blankId = useSideChatView.getState().openBlankTab("p1");
		useComposer.getState().setSideChatDraft(blankId, "Draft for p1");
		useComposer.getState().setImages(blankId, [{ id: "img-1", path: "/tmp/a.png" }]);

		const { unmount } = render(<RightPanelHeader activeTab="sidechat" tabBadges={{} as never} />);
		fireEvent.click(screen.getByRole("button", { name: /关闭标签页/ }));
		unmount();

		// Snapshot stored independently of toast
		expect(getClosedBlankSideChatDraft("p1")?.text).toBe("Draft for p1");
		const toastId = useToasts.getState().items[0].id;
		useToasts.getState().dismiss(toastId);
		expect(useToasts.getState().items).toHaveLength(0);
		expect(getClosedBlankSideChatDraft("p1")?.text).toBe("Draft for p1");

		// Switch active session to p2 before Undo
		useUi.getState().selectSession("p2");
		useUi.setState({ rightTab: "git", openRightTabs: ["git"], rightOpen: false });

		// Restore for original parent p1 -> p2's rightTab/rightOpen must NOT be hijacked
		const restoredId = restoreClosedBlankSideChatDraft("p1");
		expect(restoredId).toBeTruthy();
		expect(useSideChatView.getState().openTabs.p1).toEqual([restoredId]);
		expect(useSideChatView.getState().openTabs.p2).toBeUndefined();
		expect(useComposer.getState().sideChatDrafts[restoredId!]).toBe("Draft for p1");
		expect(useUi.getState().selectedSessionId).toBe("p2");
		expect(useUi.getState().rightTab).toBe("git");
		expect(useUi.getState().rightOpen).toBe(false);
		expect(getClosedBlankSideChatDraft("p1")).toBeUndefined();

		// Switch back to p1 and verify overwriting on next blank close
		useUi.getState().selectSession("p1");
		const secondBlank = useSideChatView.getState().openBlankTab("p1");
		useComposer.getState().setSideChatDraft(secondBlank, "First close");
		const view = render(<RightPanelHeader activeTab="sidechat" tabBadges={{} as never} />);
		fireEvent.click(screen.getAllByRole("button", { name: /关闭标签页/ })[1]);
		expect(getClosedBlankSideChatDraft("p1")?.text).toBe("First close");

		const thirdBlank = useSideChatView.getState().openBlankTab("p1");
		useComposer.getState().setSideChatDraft(thirdBlank, "Second close");
		view.rerender(<RightPanelHeader activeTab="sidechat" tabBadges={{} as never} />);
		fireEvent.click(screen.getAllByRole("button", { name: /关闭标签页/ })[1]);
		expect(getClosedBlankSideChatDraft("p1")?.text).toBe("Second close");
	});
});
