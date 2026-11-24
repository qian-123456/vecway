// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	RightPanelHeader,
	_clearClosedBlankSideChatDrafts,
	getClosedBlankSideChatDraft,
	getClosedBlankSideChatDrafts,
	restoreClosedBlankSideChatDraft,
} from "./RightPanelHeader";
import { useComposer } from "../stores/composer";
import { useSessions } from "../stores/sessions";
import { useUi } from "../stores/ui";
import { useSideChatView } from "../features/sidechat/viewStore";
import { useToasts } from "../lib/toast";
describe("RightPanelHeader blank side-chat close undo", () => {
	beforeEach(() => {
		if (typeof globalThis.ResizeObserver === "undefined") {
			globalThis.ResizeObserver = class {
				observe() {}
				unobserve() {}
				disconnect() {}
			} as unknown as typeof ResizeObserver;
		}
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

		// Switch back to p1 (closing restoredId first) and verify closing two blank tabs retains both snapshots and binds toasts per tabId (H7)
		useSideChatView.getState().closeTab("p1", restoredId!);
		useUi.getState().selectSession("p1");
		useUi.setState({ rightTab: "sidechat", openRightTabs: ["sidechat"], rightOpen: true });
		const tabA = useSideChatView.getState().openBlankTab("p1");
		const tabB = useSideChatView.getState().openBlankTab("p1");
		useComposer.getState().setSideChatDraft(tabA, "Draft A");
		useComposer.getState().setSideChatDraft(tabB, "Draft B");
		const view = render(<RightPanelHeader activeTab="sidechat" tabBadges={{} as never} />);
		fireEvent.click(screen.getAllByRole("button", { name: /关闭标签页/ })[0]);
		fireEvent.click(screen.getAllByRole("button", { name: /关闭标签页/ })[0]);
		expect(getClosedBlankSideChatDrafts("p1").map((d) => d.tabId)).toEqual([tabB, tabA]);
		expect(getClosedBlankSideChatDraft("p1", tabA)?.text).toBe("Draft A");
		expect(getClosedBlankSideChatDraft("p1", tabB)?.text).toBe("Draft B");
		expect(sessionStorage.getItem("omp_closed_blank_sidechat_drafts")).toContain("Draft A");

		// Older toast (index 0) restores tabA specifically, leaving tabB retained
		const toasts = useToasts.getState().items;
		expect(toasts).toHaveLength(2);
		toasts[0].action!.onClick();
		const tabsAfterUndoA = useSideChatView.getState().openTabs.p1 ?? [];
		expect(tabsAfterUndoA).toHaveLength(1);
		expect(useComposer.getState().sideChatDrafts[tabsAfterUndoA[0]]).toBe("Draft A");
		expect(getClosedBlankSideChatDrafts("p1").map((d) => d.tabId)).toEqual([tabB]);
		view.unmount();
	});

	it("recovers closed side-chat drafts via RightPanelHeader UI button even after toasts expire (H7)", () => {
		const tabA = useSideChatView.getState().openBlankTab("p1");
		const tabB = useSideChatView.getState().openBlankTab("p1");
		useComposer.getState().setSideChatDraft(tabA, "Expired toast draft A");
		useComposer.getState().setSideChatDraft(tabB, "Expired toast draft B");

		render(<RightPanelHeader activeTab="sidechat" tabBadges={{} as never} />);
		fireEvent.click(screen.getAllByRole("button", { name: /关闭标签页/ })[0]);
		fireEvent.click(screen.getAllByRole("button", { name: /关闭标签页/ })[0]);

		// Simulate all toasts expiring / being dismissed
		for (const item of [...useToasts.getState().items]) {
			useToasts.getState().dismiss(item.id);
		}
		expect(useToasts.getState().items).toHaveLength(0);

		// Multiple closed drafts -> header restore button opens draft list, allowing recovery of Draft A
		const restoreMultiBtn = screen.getByRole("button", { name: "恢复草稿 (2)" });
		fireEvent.click(restoreMultiBtn);
		fireEvent.click(screen.getByRole("button", { name: "Expired toast draft A" }));
		const tabsAfterA = useSideChatView.getState().openTabs.p1 ?? [];
		expect(tabsAfterA).toHaveLength(1);
		expect(useComposer.getState().sideChatDrafts[tabsAfterA[0]]).toBe("Expired toast draft A");

		// One remaining closed draft -> header restore button directly restores Draft B
		fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
		const tabsAfterB = useSideChatView.getState().openTabs.p1 ?? [];
		expect(tabsAfterB).toHaveLength(2);
		expect(useComposer.getState().sideChatDrafts[tabsAfterB[1]]).toBe("Expired toast draft B");
		expect(getClosedBlankSideChatDrafts("p1")).toHaveLength(0);
	});

	it("retains 6+ closed blank side-chat drafts without silent eviction and only deletes on explicit discard (P2-7)", () => {
		const tabIds: string[] = [];
		for (let i = 1; i <= 7; i += 1) {
			const tid = useSideChatView.getState().openBlankTab("p1");
			tabIds.push(tid);
			useComposer.getState().setSideChatDraft(tid, `Saved draft #${i}`);
		}

		render(<RightPanelHeader activeTab="sidechat" tabBadges={{} as never} />);
		for (let i = 0; i < 7; i += 1) {
			fireEvent.click(screen.getAllByRole("button", { name: /关闭标签页/ })[0]);
		}

		const retained = getClosedBlankSideChatDrafts("p1");
		expect(retained).toHaveLength(7);
		expect(retained.map((d) => d.text)).toEqual([
			"Saved draft #7",
			"Saved draft #6",
			"Saved draft #5",
			"Saved draft #4",
			"Saved draft #3",
			"Saved draft #2",
			"Saved draft #1",
		]);
		expect(sessionStorage.getItem("omp_closed_blank_sidechat_drafts")).toContain("Saved draft #1");

		// Open restore popover and explicitly discard only Saved draft #3
		fireEvent.click(screen.getByRole("button", { name: "恢复草稿 (7)" }));
		fireEvent.click(screen.getByRole("button", { name: "删除草稿：Saved draft #3" }));

		const afterDiscard = getClosedBlankSideChatDrafts("p1");
		expect(afterDiscard).toHaveLength(6);
		expect(afterDiscard.some((d) => d.text === "Saved draft #3")).toBe(false);
		expect(afterDiscard.some((d) => d.text === "Saved draft #1")).toBe(true);
	});
});
