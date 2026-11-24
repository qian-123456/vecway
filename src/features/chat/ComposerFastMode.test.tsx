// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ThinkingLevelPicker } from "../../components/ThinkingLevelPicker";
import type { ProviderRow } from "../../lib/contracts";
import { emptySessionLive, useLive } from "../../stores/live";
import { useProviders } from "../providers/store";
import { usePendingSession } from "../sessions/pendingSession";
import { ComposerFastMode, ComposerFastModeIndicator, fastModeChannel, offlineFastModeChannel } from "./ComposerFastMode";
const SID = "s1";

const h = vi.hoisted(() => ({
	rpcSend: vi.fn(async (_sessionId: string, _command: unknown) => ({}) as Record<string, unknown>),
	providerRows: vi.fn(async (): Promise<ProviderRow[]> => []),
	ensureLive: vi.fn(async (_sessionId: string) => ({})),
	toastError: vi.fn(),
	toastInfo: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
	rpcSend: h.rpcSend,
	providerRows: h.providerRows,
}));
vi.mock("../../lib/ensureLive", () => ({
	ensureLive: h.ensureLive,
	isResumeCancelled: () => false,
}));

vi.mock("../../lib/toast", () => ({
	toast: {
		error: h.toastError,
		info: h.toastInfo,
	},
}));

beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
});

beforeEach(() => {
	h.rpcSend.mockReset();
	h.providerRows.mockReset();
	h.providerRows.mockResolvedValue([]);
	h.ensureLive.mockReset();
	h.toastError.mockReset();
	h.toastInfo.mockReset();
	useLive.setState({ sessions: {} });
	usePendingSession.setState({ drafts: {}, selectedId: null });
	useProviders.setState({ rows: [], loaded: false, error: null });
});
afterEach(cleanup);

function codexState(overrides: Record<string, unknown> = {}, modelOverrides: Record<string, unknown> = {}) {
	return {
		fastModeEnabled: false,
		fastModeActive: false,
		...overrides,
		model: {
			id: "gpt-6.2-sol",
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			...modelOverrides,
		},
	};
}

function apiState(overrides: Record<string, unknown> = {}, modelOverrides: Record<string, unknown> = {}) {
	return {
		fastModeEnabled: false,
		fastModeActive: false,
		...overrides,
		model: {
			id: "gpt-5.4",
			provider: "openai",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			...modelOverrides,
		},
	};
}

function renderInThinkingPicker(modelKey: string, sessionId = SID) {
	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<ThinkingLevelPicker
				levels={["auto", "low", "medium", "high"]}
				value="high"
				open={open}
				onOpenChange={setOpen}
				onSelect={() => {}}
				accessory={<ComposerFastMode sessionId={sessionId} modelKey={modelKey} />}
			/>
		);
	}
	const view = render(<Harness />);
	fireEvent.click(screen.getByRole("button", { name: "high" }));
	return view;
}

function makeProviderRow(id: string, overrides: Partial<ProviderRow> = {}): ProviderRow {
	return {
		id,
		displayName: id,
		slug: id,
		origin: "builtin",
		sources: ["built-in"],
		baseUrl: null,
		api: null,
		models: [],
		key: { kind: "oauth", envVar: null, envSet: null },
		enabled: true,
		testable: false,
		defaultBaseUrl: null,
		extraModels: [],
		authNone: false,
		...overrides,
	};
}
describe("fastModeChannel", () => {
	it("recognizes first-party Codex and OpenAI API endpoints and rejects third-party relays", () => {
		expect(fastModeChannel(codexState(), "openai-codex/gpt-6.2-sol")).toBe("codex");
		expect(
			fastModeChannel(codexState({}, { baseUrl: "https://chatgpt.com/backend-api/" }), "openai-codex/gpt-6.2-sol"),
		).toBe("codex");
		expect(fastModeChannel(apiState(), "openai/gpt-5.4")).toBe("api");
		expect(
			fastModeChannel(apiState({}, { api: "openai-completions" }), "openai/gpt-5.4"),
		).toBe("api");

		expect(
			fastModeChannel(apiState({}, { baseUrl: "https://relay.example.com/v1" }), "openai/gpt-5.4"),
		).toBeNull();
		expect(fastModeChannel(codexState({}, { id: "gpt-5.6-sol" }), "openai-codex/gpt-5.6-sol")).toBeNull();
		expect(fastModeChannel(codexState(), "openai-codex/gpt-6.1-sol")).toBeNull();
		expect(fastModeChannel(undefined, "openai-codex/gpt-6.2-sol")).toBeNull();
	});

	it("prefers live serviceTiers metadata when present", () => {
		expect(
			fastModeChannel(codexState({}, { serviceTiers: ["flex"] }), "openai-codex/gpt-6.2-sol"),
		).toBeNull();
		expect(
			fastModeChannel(codexState({}, { id: "gpt-5.6-sol", serviceTiers: ["priority"] }), "openai-codex/gpt-5.6-sol"),
		).toBe("codex");
	});
});

describe("offlineFastModeChannel", () => {
	it("allows verified first-party OpenAI/Codex models and rejects relays, overrides, and unloaded rows", () => {
		expect(offlineFastModeChannel("openai-codex/gpt-6.1-sol", null)).toBeNull();
		expect(offlineFastModeChannel("openai-codex/gpt-6.1-sol", [])).toBe("codex");
		expect(
			offlineFastModeChannel("openai/gpt-5.4", [makeProviderRow("openai", { baseUrl: "https://api.openai.com/v1" })]),
		).toBe("api");
		expect(offlineFastModeChannel("0E-gpt/gpt-6.1-sol", [])).toBeNull();
		expect(offlineFastModeChannel("sub2api-smart/gpt-6.1-sol", [])).toBeNull();
		expect(
			offlineFastModeChannel("openai/gpt-5.4", [
				makeProviderRow("openai", { origin: "custom", baseUrl: "https://relay.example.com/v1" }),
			]),
		).toBeNull();
		expect(
			offlineFastModeChannel("openai-codex/gpt-6.1-sol", [
				makeProviderRow("openai-codex", { enabled: false }),
			]),
		).toBeNull();
	});
});

describe("ComposerFastMode", () => {
	it("renders nothing inside ThinkingLevelPicker for unsupported or unverified channels", () => {
		useLive.setState({
			sessions: {
				[SID]: {
					...emptySessionLive(),
					alive: true,
					state: apiState({}, { baseUrl: "https://relay.example.com/v1" }),
				},
			},
		});
		renderInThinkingPicker("openai/gpt-5.4");
		expect(screen.queryByRole("button", { name: /响应速度|Response speed/ })).toBeNull();
	});

	it("toggles fast mode in one click, shows enabled notice, and keeps ThinkingLevelPicker open", async () => {
		useLive.setState({
			sessions: {
				[SID]: {
					...emptySessionLive(),
					alive: true,
					state: codexState(),
				},
			},
		});
		h.rpcSend.mockImplementation(async (_sid, cmd) => {
			const c = cmd as { type: string; enabled?: boolean };
			if (c.type === "set_fast_mode") {
				const next = Boolean(c.enabled);
				useLive.getState().reduceFrame({
					sessionId: SID,
					frame: {
						type: "response",
						command: "set_fast_mode",
						success: true,
						data: { enabled: next, active: next },
					},
				});
				return { data: { enabled: next, active: next } };
			}
			return {};
		});

		renderInThinkingPicker("openai-codex/gpt-6.2-sol");

		const toggleBtn = screen.getByRole("button", { name: /响应速度：标准|Response speed: Standard/ });
		expect(toggleBtn.getAttribute("aria-pressed")).toBe("false");
		expect(screen.queryByRole("combobox")).toBeNull();

		fireEvent.click(toggleBtn);
		await waitFor(() =>
			expect(h.rpcSend).toHaveBeenCalledWith(SID, { type: "set_fast_mode", enabled: true }),
		);
		expect(h.toastInfo).toHaveBeenCalledTimes(1);

		const activeBtn = await screen.findByRole("button", {
			name: /响应速度：快速|Response speed: Fast/,
		});
		expect(activeBtn.getAttribute("aria-pressed")).toBe("true");
		expect(activeBtn.className).toContain("text-amber-500");
		expect(screen.getByRole("slider")).toBeTruthy();

		fireEvent.click(activeBtn);
		await waitFor(() =>
			expect(h.rpcSend).toHaveBeenCalledWith(SID, { type: "set_fast_mode", enabled: false }),
		);
	});

	it("renders colored toolbar indicator only when fast mode is active and allows one-click turn off", async () => {
		useLive.setState({
			sessions: {
				[SID]: {
					...emptySessionLive(),
					alive: true,
					state: codexState(),
				},
			},
		});
		h.rpcSend.mockImplementation(async (_sid, cmd) => {
			const c = cmd as { type: string; enabled?: boolean };
			if (c.type === "set_fast_mode") {
				const next = Boolean(c.enabled);
				useLive.getState().reduceFrame({
					sessionId: SID,
					frame: {
						type: "response",
						command: "set_fast_mode",
						success: true,
						data: { enabled: next, active: next },
					},
				});
				return { data: { enabled: next, active: next } };
			}
			return {};
		});

		const { rerender } = render(<ComposerFastModeIndicator sessionId={SID} modelKey="openai-codex/gpt-6.2-sol" />);
		expect(screen.queryByRole("button")).toBeNull();

		useLive.setState({
			sessions: {
				[SID]: {
					...emptySessionLive(),
					alive: true,
					state: codexState({ fastModeEnabled: true, fastModeActive: true }),
				},
			},
		});
		rerender(<ComposerFastModeIndicator sessionId={SID} modelKey="openai-codex/gpt-6.2-sol" />);
		const indicator = screen.getByRole("button", { name: /响应速度：快速|Response speed: Fast/ });
		expect(indicator.className).toContain("text-amber-500");

		fireEvent.click(indicator);
		await waitFor(() =>
			expect(h.rpcSend).toHaveBeenCalledWith(SID, { type: "set_fast_mode", enabled: false }),
		);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("wakes an idle session and re-verifies channel before calling set_fast_mode", async () => {
		useLive.setState({
			sessions: {
				[SID]: {
					...emptySessionLive(),
					alive: false,
					state: apiState(),
				},
			},
		});
		h.ensureLive.mockImplementation(async () => {
			useLive.setState((s) => ({
				sessions: { ...s.sessions, [SID]: { ...s.sessions[SID]!, alive: true } },
			}));
			return {};
		});
		h.rpcSend.mockImplementation(async (_sid, cmd) => {
			const c = cmd as { type: string };
			if (c.type === "get_state") {
				return { data: apiState({}, { baseUrl: "https://relay.example.com/v1" }) };
			}
			return {};
		});

		renderInThinkingPicker("openai/gpt-5.4");
		fireEvent.click(screen.getByRole("button", { name: /响应速度：标准|Response speed: Standard/ }));

		await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
		expect(h.ensureLive).toHaveBeenCalledWith(SID);
		expect(h.rpcSend).not.toHaveBeenCalledWith(SID, expect.objectContaining({ type: "set_fast_mode" }));
	});

	it("shows fast mode on a local draft for first-party Codex and persists the toggle locally", async () => {
		const draftId = usePendingSession.getState().open({ cwd: "/repo", model: "openai-codex/gpt-6.1-sol" });
		h.providerRows.mockResolvedValue([makeProviderRow("openai-codex")]);

		renderInThinkingPicker("openai-codex/gpt-6.1-sol", draftId);

		const toggleBtn = await screen.findByRole("button", { name: /响应速度：标准|Response speed: Standard/ });
		fireEvent.click(toggleBtn);

		expect(usePendingSession.getState().drafts[draftId].fastMode).toBe(true);
		expect(h.ensureLive).not.toHaveBeenCalled();
		expect(h.rpcSend).not.toHaveBeenCalled();
		expect(h.toastInfo).toHaveBeenCalledTimes(1);

		const activeBtn = await screen.findByRole("button", { name: /响应速度：快速|Response speed: Fast/ });
		expect(activeBtn.getAttribute("aria-pressed")).toBe("true");
		expect(activeBtn.className).toContain("text-amber-500");
	});

	it("hides fast mode on a local draft for third-party relays or custom baseUrl overrides", async () => {
		const draftId = usePendingSession.getState().open({ cwd: "/repo", model: "0E-gpt/gpt-6.1-sol" });
		useProviders.setState({
			rows: [makeProviderRow("openai", { origin: "custom", baseUrl: "https://relay.example.com/v1" })],
			loaded: true,
			error: null,
		});

		renderInThinkingPicker("0E-gpt/gpt-6.1-sol", draftId);
		expect(screen.queryByRole("button", { name: /响应速度|Response speed/ })).toBeNull();

		cleanup();
		renderInThinkingPicker("openai/gpt-5.4", draftId);
		expect(screen.queryByRole("button", { name: /响应速度|Response speed/ })).toBeNull();
	});
});
