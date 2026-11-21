// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EventsModule from "../../lib/events";
import type * as IpcModule from "../../lib/ipc";
import { useComposer } from "../../stores/composer";
import { emptySessionLive, useLive } from "../../stores/live";
import { useSessions } from "../../stores/sessions";
import type * as DraftSessionModule from "../sessions/draftSession";
import { usePendingSession } from "../sessions/pendingSession";
import { Composer } from "./Composer";
import { PromptComposer } from "./PromptComposer";

const S1 = "scroll-lock-s1";

vi.mock("../../components/ImagePreviewModal", () => ({
	ImagePreviewModal: () => null,
}));
vi.mock("../../lib/ipc", async (importOriginal) => {
	const orig = await importOriginal<typeof IpcModule>();
	return {
		...orig,
		rpcSend: vi.fn(async () => ({})),
		rpcEnsureLive: vi.fn(async () => ({ sessionId: S1 })),
		rpcRelease: vi.fn(async () => {}),
		ompModelRolesRead: vi.fn(async () => ({
			global: { path: "/g", exists: true, modelRoles: {}, agentModelOverrides: {} },
			project: null,
			agents: [],
		})),
		ompModelRolesSet: vi.fn(async () => ({})),
		ompConfigList: vi.fn(async () => ({ found: true, entries: [] })),
		sessionUsage: vi.fn(async () => ({ available: false, tokens: 0 })),
		sessionSnapshot: vi.fn(async () => ({})),
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
	return { ...orig, materializeDraft: vi.fn(async () => S1), warmDraft: () => {}, prewarmDraft: async () => S1 };
});
vi.mock("@tauri-apps/api/webview", () => ({
	getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));
vi.mock("../../lib/events", async (importOriginal) => {
	const orig = await importOriginal<typeof EventsModule>();
	return { ...orig, onPrivacyChanged: async () => () => {} };
});

beforeAll(() => {
	class RO {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", RO);
	Element.prototype.scrollIntoView = () => {};
	Object.assign(window, { __TAURI_INTERNALS__: { convertFileSrc: (p: string) => `asset://${p}` } });
});

const flush = () =>
	act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});

function mockScrollHeight(ta: HTMLTextAreaElement, value: number) {
	Object.defineProperty(ta, "scrollHeight", {
		configurable: true,
		get: () => value,
	});
}

function dispatchWheel(ta: HTMLTextAreaElement, init: { deltaX: number; deltaY: number }) {
	const event = createEvent.wheel(ta, { ...init, cancelable: true });
	fireEvent(ta, event);
	return event;
}

describe.each([
	{
		name: "Composer",
		mount: async () => {
			act(() => {
				useLive.setState({
					sessions: {
						[S1]: {
							...emptySessionLive(),
							alive: true,
							state: { model: { provider: "p", id: "m" }, thinkingLevel: "low" },
							plan: { enabled: false, version: 0 },
							commands: [],
						},
					} as never,
				});
			});
			render(<Composer sessionId={S1} />);
			await flush();
			return document.querySelector<HTMLTextAreaElement>(`textarea[data-composer="${S1}"]`)!;
		},
	},
	{
		name: "PromptComposer",
		mount: async () => {
			render(
				<PromptComposer
					id="prompt-lock-test"
					cwd="/repo/alpha"
					onChangeCwd={() => {}}
					runMode="local"
					isGitRepo={false}
					onChangeRunMode={() => {}}
					modelValue=""
					onChangeModel={() => {}}
					promptValue=""
					onChangePrompt={() => {}}
				/>,
			);
			await flush();
			return document.querySelector<HTMLTextAreaElement>('textarea[data-composer="prompt-lock-test"]')!;
		},
	},
])("$name textarea scroll lock", ({ mount }) => {
	beforeEach(() => {
		localStorage.clear();
		useComposer.setState({ drafts: {}, annotations: {}, images: {}, files: {}, history: [] });
		useLive.setState({ sessions: {} });
		useSessions.setState({ sessions: {}, workspaces: [] } as never);
		usePendingSession.setState({ drafts: {}, selectedId: null });
	});

	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
	});

	it("applies overflow-x-hidden, overflow-y-hidden, and overscroll-none classes plus hidden overflowX style", async () => {
		const ta = await mount();
		expect(ta.className).toContain("overflow-x-hidden");
		expect(ta.className).toContain("overflow-y-hidden");
		expect(ta.className).toContain("overscroll-none");
		expect(ta.style.overflowX).toBe("hidden");
	});

	it("clamps scrollLeft and scrollTop to 0 when content does not exceed maxH", async () => {
		const ta = await mount();
		mockScrollHeight(ta, 32);

		// Simulate text change triggering fit() with non-zero stale scroll offsets.
		ta.scrollLeft = 18;
		ta.scrollTop = 24;
		fireEvent.change(ta, { target: { value: "short draft", selectionStart: 11, selectionEnd: 11 } });
		await flush();

		expect(ta.style.overflowX).toBe("hidden");
		expect(ta.style.overflowY).toBe("hidden");
		expect(ta.scrollLeft).toBe(0);
		expect(ta.scrollTop).toBe(0);

		// Any subsequent native scroll event while not overflowing must also clamp back to 0.
		ta.scrollLeft = 12;
		ta.scrollTop = 16;
		fireEvent.scroll(ta);
		expect(ta.scrollLeft).toBe(0);
		expect(ta.scrollTop).toBe(0);
	});

	it("preserves vertical scrollTop while clamping scrollLeft to 0 when content exceeds maxH", async () => {
		const ta = await mount();
		mockScrollHeight(ta, 360);

		ta.scrollLeft = 20;
		ta.scrollTop = 90;
		fireEvent.change(ta, { target: { value: "line\n".repeat(30), selectionStart: 10, selectionEnd: 10 } });
		await flush();

		expect(ta.style.overflowY).toBe("auto");
		expect(ta.scrollLeft).toBe(0);
		expect(ta.scrollTop).toBe(90);

		ta.scrollLeft = 14;
		ta.scrollTop = 110;
		fireEvent.scroll(ta);
		expect(ta.scrollLeft).toBe(0);
		expect(ta.scrollTop).toBe(110);
	});

	it("prevents horizontal wheel events and resets scrollLeft, while leaving vertical wheel events unblocked", async () => {
		const ta = await mount();

		ta.scrollLeft = 25;
		const horizontal = dispatchWheel(ta, { deltaX: 40, deltaY: 2 });
		expect(horizontal.defaultPrevented).toBe(true);
		expect(ta.scrollLeft).toBe(0);

		const vertical = dispatchWheel(ta, { deltaX: 0, deltaY: 40 });
		expect(vertical.defaultPrevented).toBe(false);
	});
});
