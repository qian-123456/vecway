// @vitest-environment jsdom
/**
 * Plan mode from a new-chat draft: the command chip must not follow the draft
 * onto the real session, a failed command keeps it, and the plan tab opens only
 * for a newer plan revision.
 */

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "../../lib/ipc";
import type * as EventsModule from "../../lib/events";
import type * as DraftSessionModule from "../sessions/draftSession";
import { emptySessionLive, useLive } from "../../stores/live";
import { useComposer } from "../../stores/composer";
import { useUi } from "../../stores/ui";
import { usePendingSession } from "../sessions/pendingSession";
import { loadChip, saveChip } from "./slash/chip";
import { Composer } from "./Composer";
import { useTreeEditPending } from "./treeNav";
import { PLAN_OFF, PLAN_STATUS_KEY, type PlanStatus } from "./plan/planStatus";
import { abortTurn } from "./send";

const DRAFT = "local-draft:plan-1";
const REAL = "real-1";

const h = vi.hoisted(() => ({
	rpcSend: vi.fn(async (_id: string, _cmd: unknown) => ({}) as Record<string, unknown>),
	materialize: vi.fn<(id: string) => Promise<string>>(),
	sessionSnapshot: vi.fn<() => Promise<Record<string, unknown>>>(),
}));

vi.mock("../../lib/ipc", async (importOriginal) => {
	const orig = await importOriginal<typeof IpcModule>();
	return {
		...orig,
		rpcSend: h.rpcSend,
		rpcEnsureLive: vi.fn(async () => ({ sessionId: REAL })),
		sessionUsage: vi.fn(async () => ({ available: false, tokens: 0 })),
		sessionSnapshot: h.sessionSnapshot,
		skillsList: vi.fn(async () => ({ skills: [], extensions: [] })),
		listWorkspaceFiles: vi.fn(async () => []),
		listModels: vi.fn(async () => ({ models: [], source: "cli", completeness: "unverified" })),
		listSessions: vi.fn(async () => []),
		listWorkspaces: vi.fn(async () => []),
		getSettings: vi.fn(async () => null),
		gitBadge: vi.fn(async () => null),
		privacyList: vi.fn(async () => ({ entries: [], nativeStatus: "missing", nativeError: null })),
		privacySessionEntryIds: vi.fn(async () => []),
		mcpConfigList: vi.fn(async () => ({ servers: [] })),
		pluginsList: vi.fn(async () => ({ roots: [], plugins: [] })),
	};
});
vi.mock("../sessions/draftSession", async (importOriginal) => {
	const orig = await importOriginal<typeof DraftSessionModule>();
	return { ...orig, materializeDraft: h.materialize, warmDraft: () => {}, prewarmDraft: async () => REAL };
});
vi.mock("@tauri-apps/api/webview", () => ({
	getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../../lib/events", async (importOriginal) => {
	const orig = await importOriginal<typeof EventsModule>();
	return { ...orig, onPrivacyChanged: async () => () => {} };
});
vi.mock("../../stores/modelCatalog", () => ({
	useModelOptions: () => null,
	useModelCatalog: Object.assign(vi.fn(() => null), {
		getState: () => ({ models: [], refresh: () => Promise.resolve() }),
	}),
}));
vi.mock("../../components/ModelSelect", () => ({
	ModelMenuContent: () => <div data-testid="model-menu" />,
}));

beforeAll(() => {
	class RO {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", RO);
	Element.prototype.scrollIntoView = () => {};
});

const PLAN_CHIP = { name: "plan", title: "规划模式", argHint: "<任务>" };

beforeEach(async () => {
	localStorage.clear();
	h.rpcSend.mockClear();
	h.materialize.mockReset();
	h.sessionSnapshot.mockReset().mockResolvedValue({});
	useUi.setState({ rightTab: "git" } as never);
	useComposer.setState({ drafts: {}, annotations: {}, images: {}, files: {}, history: [] });
	usePendingSession.setState({
		drafts: {
			[DRAFT]: {
				id: DRAFT, cwd: "/tmp/proj", mode: "code", groupId: null,
				opts: { cwd: "/tmp/proj" } as never, model: null, thinking: null,
				sessionId: null, startError: null,
			},
		},
		selectedId: DRAFT,
	});
	useLive.setState({
		sessions: {
			[DRAFT]: { ...emptySessionLive(), alive: true, state: {} },
			[REAL]: { ...emptySessionLive(), alive: true, state: {} },
		},
	});
});

afterEach(() => {
	cleanup();
	useTreeEditPending.setState({ entries: {} });
	document.body.innerHTML = "";
});

const ta = (id: string): HTMLTextAreaElement => {
	const el = document.querySelector<HTMLTextAreaElement>(`textarea[data-composer="${id}"]`);
	if (!el) throw new Error("composer textarea not rendered");
	return el;
};

describe("Composer while a message edit is being prepared", () => {
	it("prevents input and sending until navigation completes without losing the draft", () => {
		useComposer.getState().setDraft(REAL, "unsent text");
		useTreeEditPending.setState({ entries: { [REAL]: "message-1" } });
		const view = render(<Composer sessionId={REAL} />);
		expect(ta(REAL).disabled).toBe(true);
		expect((view.getByRole("button", { name: "发送消息" }) as HTMLButtonElement).disabled).toBe(true);
		expect(ta(REAL).value).toBe("unsent text");
		act(() => useTreeEditPending.setState({ entries: {} }));
		expect(ta(REAL).disabled).toBe(false);
		expect(ta(REAL).value).toBe("unsent text");
	});
});

describe("Composer plan chip on a new-chat draft", () => {
	it("does not carry the chip to the materialized session", async () => {
		const { transferDraft } = await vi.importActual<typeof DraftSessionModule>("../sessions/draftSession");
		h.materialize.mockImplementation(async (id) => {
			transferDraft(id, REAL);
			return REAL;
		});
		saveChip(DRAFT, PLAN_CHIP);
		useComposer.getState().setDraft(DRAFT, "write a plan");
		render(<Composer sessionId={DRAFT} />);

		fireEvent.keyDown(ta(DRAFT), { key: "Enter" });

		await waitFor(() => expect(h.materialize).toHaveBeenCalledWith(DRAFT));
		await waitFor(() => expect(h.rpcSend).toHaveBeenCalled());
		expect(loadChip(REAL)).toBeNull();
		expect(loadChip(DRAFT)).toBeNull();
	});

	it("keeps the chip for retry when the command fails on the same composer", async () => {
		h.materialize.mockRejectedValue(new Error("spawn failed"));
		saveChip(DRAFT, PLAN_CHIP);
		useComposer.getState().setDraft(DRAFT, "write a plan");
		render(<Composer sessionId={DRAFT} />);

		fireEvent.keyDown(ta(DRAFT), { key: "Enter" });

		await waitFor(() => expect(h.materialize).toHaveBeenCalled());
		await waitFor(() => expect(loadChip(DRAFT)).toEqual(PLAN_CHIP));
		expect(document.querySelector("[data-command-chip]")).not.toBeNull();
	});
});


describe("submitted annotation ownership after draft handoff", () => {
	it("consumes transferred quotes without discarding quotes added after submission", async () => {
		const { transferDraft } = await vi.importActual<typeof DraftSessionModule>("../sessions/draftSession");
		h.materialize.mockImplementation(async (id) => {
			transferDraft(id, REAL);
			useComposer.getState().addAnnotation(REAL, { source: "message", text: "next quote" });
			return REAL;
		});
		useComposer.getState().addAnnotation(DRAFT, { source: "message", text: "submitted quote" });
		useComposer.getState().setDraft(DRAFT, "/zzunknown task");
		render(<Composer sessionId={DRAFT} />);
		fireEvent.keyDown(ta(DRAFT), { key: "Enter" });
		await waitFor(() => expect(useComposer.getState().drafts[REAL]).toBe(""));
		expect(useComposer.getState().annotations[REAL]?.map((annotation) => annotation.text)).toEqual(["next quote"]);
		const commands = h.rpcSend.mock.calls.map(([, command]) => command);
		const prompt = commands.find((command) => command !== null && typeof command === "object" && "type" in command && command.type === "prompt");
		expect(prompt).toEqual(expect.objectContaining({ message: expect.stringContaining("submitted quote") }));
		expect(prompt).toEqual(expect.objectContaining({ message: expect.not.stringContaining("next quote") }));
	});
	it.each(["source", "target"] as const)("keeps retyped identical input in the %s during a late slash handoff", async (phase) => {
		const { transferDraft } = await vi.importActual<typeof DraftSessionModule>("../sessions/draftSession");
		let handoff!: () => void;
		const materializing = new Promise<void>((resolve) => { handoff = resolve; });
		let finish!: (value: Record<string, unknown>) => void;
		const pending = new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
		h.materialize.mockImplementation(async (id) => {
			await materializing;
			transferDraft(id, REAL);
			return REAL;
		});
		h.rpcSend.mockImplementation((_sid, command) =>
			command !== null && typeof command === "object" && "type" in command && command.type === "prompt"
				? pending : Promise.resolve({}),
		);
		const submitted = "/zzunknown same 📎#1";
		useComposer.getState().addFile(DRAFT, "/old.txt");
		useComposer.getState().setDraft(DRAFT, submitted);
		render(<Composer sessionId={DRAFT} />);
		fireEvent.keyDown(ta(DRAFT), { key: "Enter" });
		await waitFor(() => expect(h.materialize).toHaveBeenCalled());
		if (phase === "target") {
			await act(async () => { handoff(); });
			await waitFor(() => expect(h.rpcSend).toHaveBeenCalledWith(REAL, expect.objectContaining({ type: "prompt" })));
			cleanup();
			render(<Composer sessionId={REAL} />);
		}
		const owner = phase === "source" ? DRAFT : REAL;
		fireEvent.change(ta(owner), { target: { value: "" } });
		act(() => { useComposer.getState().addFile(owner, "/new.txt"); });
		fireEvent.change(ta(owner), { target: { value: submitted } });
		if (phase === "source") {
			await act(async () => { handoff(); });
			await waitFor(() => expect(h.rpcSend).toHaveBeenCalledWith(REAL, expect.objectContaining({ type: "prompt" })));
		}
		await act(async () => { finish({}); });
		expect(useComposer.getState().drafts[REAL]).toBe(submitted);
		expect(useComposer.getState().files[REAL]?.map((file) => file.path)).toEqual(["/new.txt"]);
		h.rpcSend.mockResolvedValue({});
	});
});


describe("plan tab auto-open", () => {
	beforeEach(() => {
		// Session selection restores its remembered panel. Seed that first,
		// then the target panel; combining both in setState is overwritten.
		useUi.getState().selectSession(REAL);
		useUi.setState({ rightOpen: true, rightTab: "git", openRightTabs: ["git"] });
		useLive.setState((state) => ({ sessions: { ...state.sessions, [REAL]: emptySessionLive() } }));
	});
	const review = (version: number): PlanStatus => ({
		...PLAN_OFF, enabled: true, phase: "review", content: "# Plan\n\nBody", version,
	});
	const setPlan = (plan: PlanStatus | undefined, streaming = false, id = REAL) =>
		act(() => {
			useLive.setState((state) => ({
				sessions: { ...state.sessions, [id]: { ...emptySessionLive(), alive: true, state: {}, streaming, plan } },
			}));
		});

	it("opens only for a newer revision, not for resume or mode start", () => {
		setPlan(review(3));
		render(<Composer sessionId={REAL} />);
		expect(useUi.getState().rightTab).toBe("git");
		setPlan(review(3));
		expect(useUi.getState().rightTab).toBe("git");
		setPlan(review(4));
		expect(useUi.getState().rightTab).toBe("plan");
	});

	it("waits for the terminal agent event after an atomic review status frame", () => {
		setPlan({ ...PLAN_OFF, enabled: true });
		render(<Composer sessionId={REAL} />);
		act(() => useLive.getState().reduceFrame({ sessionId: REAL, frame: { type: "agent_start" } }));
		act(() => useLive.getState().reduceFrame({ sessionId: REAL, frame: {
			type: "extension_ui_request", method: "setStatus", statusKey: PLAN_STATUS_KEY,
			statusText: JSON.stringify({ v: 1, ...review(1) }),
		} }));
		expect(useUi.getState().rightTab).toBe("git");
		act(() => useLive.getState().reduceFrame({ sessionId: REAL, frame: { type: "turn_end" } }));
		expect(useUi.getState().rightTab).toBe("git");
		act(() => useLive.getState().reduceFrame({ sessionId: REAL, frame: { type: "agent_end" } }));
		expect(useUi.getState().rightTab).toBe("plan");
	});

	it("keeps an early version pending through phase, blank body and turn end", () => {
		setPlan({ ...PLAN_OFF, enabled: true });
		render(<Composer sessionId={REAL} />);
		setPlan({ ...review(1), phase: "planning", content: null }, true);
		expect(useUi.getState().rightTab).toBe("git");
		setPlan({ ...review(1), phase: "planning" }, true);
		expect(useUi.getState().rightTab).toBe("git");
		setPlan({ ...review(1), content: " \n " }, false);
		expect(useUi.getState().rightTab).toBe("git");
		setPlan(review(1), true);
		expect(useUi.getState().rightTab).toBe("git");
		setPlan(review(1), false);
		expect(useUi.getState().rightTab).toBe("plan");
	});

	it("respects dismissal across frames, but reopens the next completed revision", () => {
		setPlan(review(1));
		render(<Composer sessionId={REAL} />);
		setPlan(review(2));
		act(() => useUi.getState().closeRightTab("plan"));
		expect(useUi.getState().rightTab).toBe("git");
		setPlan(review(2));
		setPlan(review(2), true);
		setPlan(review(2), false);
		expect(useUi.getState().rightTab).toBe("git");
		setPlan(review(3));
		expect(useUi.getState().rightTab).toBe("plan");
	});

	it("does not pop a draft after abortTurn or a late revision in the stopped turn", async () => {
		setPlan(review(1));
		render(<Composer sessionId={REAL} />);
		setPlan(review(2), true);
		await act(async () => {
			const stopping = abortTurn(REAL);
			useLive.getState().reduceFrame({ sessionId: REAL, frame: { type: "agent_end", aborted: true } });
			await stopping;
		});
		expect(useUi.getState().rightTab).toBe("git");
		act(() => useLive.getState().reduceFrame({ sessionId: REAL, frame: {
			type: "extension_ui_request", method: "setStatus", statusKey: PLAN_STATUS_KEY,
			statusText: JSON.stringify({ v: 1, ...review(3) }),
		} }));
		expect(useUi.getState().rightTab).toBe("git");
		act(() => useLive.getState().reduceFrame({ sessionId: REAL, frame: { type: "agent_start" } }));
		act(() => useLive.getState().reduceFrame({ sessionId: REAL, frame: {
			type: "extension_ui_request", method: "setStatus", statusKey: PLAN_STATUS_KEY,
			statusText: JSON.stringify({ v: 1, ...review(4) }),
		} }));
		expect(useUi.getState().rightTab).toBe("git");
		act(() => useLive.getState().reduceFrame({ sessionId: REAL, frame: { type: "agent_end" } }));
		expect(useUi.getState().rightTab).toBe("plan");
	});

	it("does not treat a process exit as a completed revision", () => {
		setPlan(review(1));
		render(<Composer sessionId={REAL} />);
		setPlan(review(2), true);
		act(() => useLive.getState().reduceProcess({ sessionId: REAL, running: false, exitCode: 1 }));
		expect(useUi.getState().rightTab).toBe("git");
	});

	it("treats a higher version in a switched session as its baseline", () => {
		setPlan(review(1));
		setPlan(review(9), false, "other");
		const view = render(<Composer sessionId={REAL} />);
		act(() => {
			useUi.getState().selectSession("other");
			useUi.getState().setRightTab("explorer");
		});
		view.rerender(<Composer sessionId="other" />);
		expect(useUi.getState().rightTab).toBe("explorer");
		setPlan(review(10), false, "other");
		expect(useUi.getState().rightTab).toBe("plan");
	});

	it("does not let a mounted compact child steal its selected parent's side-chat panel", () => {
		const child = "sidechat-child";
		setPlan(review(1), false, child);
		useUi.setState({ rightTab: "sidechat", openRightTabs: ["sidechat"] });
		// SideChatPanel mounts a compact SessionView/Composer for the child
		// while selectedSessionId remains the parent.
		render(<Composer sessionId={child} compact />);
		act(() => useLive.getState().reduceFrame({ sessionId: child, frame: {
			type: "extension_ui_request", method: "setStatus", statusKey: PLAN_STATUS_KEY,
			statusText: JSON.stringify({ v: 1, ...review(2) }),
		} }));
		expect(useUi.getState().selectedSessionId).toBe(REAL);
		expect(useUi.getState().rightTab).toBe("sidechat");
		expect(useUi.getState().openRightTabs).toEqual(["sidechat"]);
	});

	it("does not open when the first status frame restores a plan or mode starts at zero", () => {
		setPlan(undefined);
		render(<Composer sessionId={REAL} />);
		setPlan(review(7));
		expect(useUi.getState().rightTab).toBe("git");
		setPlan({ ...PLAN_OFF, enabled: true });
		expect(useUi.getState().rightTab).toBe("git");
	});

	it("restores a cold approved snapshot without waking RPC or opening the panel", async () => {
		h.sessionSnapshot.mockResolvedValue({ planState: { enabled: false, approved: {
			content: "# Saved", version: 2, status: "completed",
		} } });
		render(<Composer sessionId={REAL} />);
		await waitFor(() => expect(useLive.getState().sessions[REAL].plan?.approved?.content).toBe("# Saved"));
		expect(useUi.getState().rightTab).toBe("git");
		expect(h.rpcSend).not.toHaveBeenCalledWith(REAL, expect.objectContaining({ message: "/plan-action status" }));
	});

	it("uses a cold review as a baseline and only opens a subsequent completed revision", async () => {
		h.sessionSnapshot.mockResolvedValue({ planState: {
			enabled: true, phase: "review", lastContent: "# Restored\n\nSaved body", version: 8,
		} });
		render(<Composer sessionId={REAL} />);
		await waitFor(() => expect(useLive.getState().sessions[REAL].plan?.version).toBe(8));
		expect(useUi.getState().rightTab).toBe("git");
		setPlan(review(9));
		expect(useUi.getState().rightTab).toBe("plan");
	});

	it("never overwrites a newer live frame with a late disk snapshot", async () => {
		let finish!: (value: Record<string, unknown>) => void;
		h.sessionSnapshot.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
		render(<Composer sessionId={REAL} />);
		const livePlan = review(11);
		act(() => useLive.getState().reduceFrame({ sessionId: REAL, frame: {
			type: "extension_ui_request", method: "setStatus", statusKey: PLAN_STATUS_KEY,
			statusText: JSON.stringify({ v: 1, ...livePlan }),
		} }));
		const receivedPlan = useLive.getState().sessions[REAL].plan;
		await act(async () => finish({ planState: { enabled: false } }));
		expect(useLive.getState().sessions[REAL].plan).toBe(receivedPlan);
		expect(useUi.getState().rightTab).toBe("git");
	});

	it("does not invent a plan status for a cold session without a persisted record", async () => {
		render(<Composer sessionId={REAL} />);
		await waitFor(() => expect(h.sessionSnapshot).toHaveBeenCalledWith(REAL));
		expect(useLive.getState().sessions[REAL].plan).toBeUndefined();
	});
});
