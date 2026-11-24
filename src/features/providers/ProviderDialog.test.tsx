// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderRow } from "../../lib/contracts";
import { tNow } from "../../stores/language";

const upsert = vi.hoisted(() => vi.fn(async (_config: unknown, _key: unknown) => ({})));
const saveBuiltin = vi.hoisted(() => vi.fn(async () => ({})));
const runModelTest = vi.hoisted(() => vi.fn(async (_providerId: string, _modelId: string) => {}));
const ompModelsSetContextWindows = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./store", () => ({
	useProviders: (select: (state: unknown) => unknown) =>
		select({
			rows: [],
			upsert,
			saveBuiltin,
			runModelTest,
			tests: {},
			modelTests: {},
		}),
}));
vi.mock("../../lib/ipc", () => ({
	providerFetchModels: vi.fn(),
	providerReadEnvFile: vi.fn(),
	listModels: vi.fn(async () => ({ models: [], source: "cli", completeness: "unverified" })),
	ompModelsSetContextWindows,
}));
vi.mock("../../stores/modelCatalog", () => ({
	useModelCatalog: { getState: () => ({ refresh: vi.fn(async () => {}) }) },
}));
vi.mock("../../lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../lib/dialogs", () => ({ confirmDialog: vi.fn(async () => true), errMsg: String }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/u" }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { loadProviderWindows, setProviderWindow } from "../settings/contextWindow/core";
import { ProviderDialog } from "./ProviderDialog";

vi.stubGlobal(
	"ResizeObserver",
	class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
);

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	localStorage.clear();
});

function makeProvider(overrides: Partial<ProviderRow> = {}): ProviderRow {
	return {
		id: "custom-gw",
		displayName: "Custom Gateway",
		origin: "custom",
		baseUrl: "https://api.example.com/v1",
		defaultBaseUrl: null,
		api: "openai-completions",
		models: ["gpt-4o", "claude-3-7-sonnet", "gpt-4.1"],
		extraModels: [],
		authNone: false,
		key: { kind: "inline", masked: "sk-***" },
		testable: true,
		enabled: true,
		discoveryType: null,
		...overrides,
	} as unknown as ProviderRow;
}

describe("ProviderDialog model search and scoped batch actions", () => {
	it("filters models in real time, updates matched/total pill, and supports empty-filter recovery", () => {
		render(<ProviderDialog target={{ mode: "edit", row: makeProvider() }} onClose={vi.fn()} />);

		expect(screen.getByText("3")).toBeTruthy();
		const searchInput = screen.getByLabelText(tNow("providers.modelSearchAria")) as HTMLInputElement;

		fireEvent.change(searchInput, { target: { value: "GPT" } });
		expect(screen.getByText("2 / 3")).toBeTruthy();
		expect(screen.getByDisplayValue("gpt-4o")).toBeTruthy();
		expect(screen.getByDisplayValue("gpt-4.1")).toBeTruthy();
		expect(screen.queryByDisplayValue("claude-3-7-sonnet")).toBeNull();

		fireEvent.change(searchInput, { target: { value: "does-not-exist" } });
		expect(screen.getByText("0 / 3")).toBeTruthy();
		expect(screen.getByText(tNow("providers.noMatchingModels"))).toBeTruthy();
		expect((screen.getByLabelText(tNow("providers.colContextWindow")) as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByLabelText(tNow("providers.batchMaxTokensAria")) as HTMLInputElement).disabled).toBe(true);

		fireEvent.click(screen.getByText(tNow("providers.clearModelSearchBtn")));
		expect(searchInput.value).toBe("");
		expect(screen.getByText("3")).toBeTruthy();
		expect(screen.getByDisplayValue("claude-3-7-sonnet")).toBeTruthy();
	});

	it("clears search when adding a non-matching model via the bottom add bar", () => {
		render(<ProviderDialog target={{ mode: "edit", row: makeProvider() }} onClose={vi.fn()} />);
		const searchInput = screen.getByLabelText(tNow("providers.modelSearchAria")) as HTMLInputElement;

		fireEvent.change(searchInput, { target: { value: "claude" } });
		expect(screen.getByText("1 / 3")).toBeTruthy();

		fireEvent.change(screen.getByLabelText(tNow("providers.newModelInputAria")), {
			target: { value: "gemini-2.5-pro" },
		});
		fireEvent.click(screen.getByRole("button", { name: tNow("providers.addModelBtn") }));

		expect(searchInput.value).toBe("");
		expect(screen.getByDisplayValue("gemini-2.5-pro")).toBeTruthy();
		expect(screen.getByText("4")).toBeTruthy();
	});

	it("preserves original row indices when editing and deleting filtered rows", () => {
		render(<ProviderDialog target={{ mode: "edit", row: makeProvider() }} onClose={vi.fn()} />);
		const searchInput = screen.getByLabelText(tNow("providers.modelSearchAria"));

		// Filter to index 2 ("gpt-4.1") and edit its context window
		fireEvent.change(searchInput, { target: { value: "4.1" } });
		fireEvent.change(screen.getByLabelText(tNow("providers.contextWindowAria", { index: 3 })), {
			target: { value: "1000000" },
		});

		fireEvent.change(searchInput, { target: { value: "" } });
		expect((screen.getByLabelText(tNow("providers.contextWindowAria", { index: 1 })) as HTMLInputElement).value).toBe("");
		expect((screen.getByLabelText(tNow("providers.contextWindowAria", { index: 2 })) as HTMLInputElement).value).toBe("");
		expect((screen.getByLabelText(tNow("providers.contextWindowAria", { index: 3 })) as HTMLInputElement).value).toBe("1000000");

		// Filter to index 1 ("claude-3-7-sonnet") and delete it
		fireEvent.change(searchInput, { target: { value: "claude" } });
		fireEvent.click(screen.getByLabelText(tNow("providers.deleteModelAria", { index: 2 })));

		fireEvent.change(searchInput, { target: { value: "" } });
		expect(screen.getByDisplayValue("gpt-4o")).toBeTruthy();
		expect(screen.queryByDisplayValue("claude-3-7-sonnet")).toBeNull();
		expect(screen.getByDisplayValue("gpt-4.1")).toBeTruthy();
		expect((screen.getByLabelText(tNow("providers.contextWindowAria", { index: 2 })) as HTMLInputElement).value).toBe("1000000");
	});

	it("scopes batch adjust and batch clear to filtered rows without changing provider default window", async () => {
		setProviderWindow("custom-gw", 200000);
		const provider = makeProvider({
			models: [
				{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 },
				{ id: "claude-3-7-sonnet", contextWindow: 200000, maxTokens: 8192 },
				{ id: "gpt-4.1", contextWindow: 128000, maxTokens: 4096 },
			],
		});
		render(<ProviderDialog target={{ mode: "edit", row: provider }} onClose={vi.fn()} />);

		const searchInput = screen.getByLabelText(tNow("providers.modelSearchAria"));
		const batchCtxInput = screen.getByLabelText(tNow("providers.colContextWindow")) as HTMLInputElement;
		const batchMaxInput = screen.getByLabelText(tNow("providers.batchMaxTokensAria")) as HTMLInputElement;

		expect(batchCtxInput.value).toBe("200000");

		fireEvent.change(searchInput, { target: { value: "gpt" } });
		expect(screen.getByText(tNow("providers.batchAdjustMatchedLabel", { count: 2 }))).toBeTruthy();
		expect(batchCtxInput.value).toBe("");
		expect(batchMaxInput.value).toBe("");

		fireEvent.change(batchCtxInput, { target: { value: "256000" } });
		fireEvent.change(batchMaxInput, { target: { value: "16384" } });

		// Clear search: only matched rows changed, provider-level batch input restored to 200000
		fireEvent.change(searchInput, { target: { value: "" } });
		expect(batchCtxInput.value).toBe("200000");
		expect((screen.getByLabelText(tNow("providers.contextWindowAria", { index: 1 })) as HTMLInputElement).value).toBe("256000");
		expect((screen.getByLabelText(tNow("providers.maxTokensAria", { index: 1 })) as HTMLInputElement).value).toBe("16384");
		expect((screen.getByLabelText(tNow("providers.contextWindowAria", { index: 2 })) as HTMLInputElement).value).toBe("200000");
		expect((screen.getByLabelText(tNow("providers.maxTokensAria", { index: 2 })) as HTMLInputElement).value).toBe("8192");
		expect((screen.getByLabelText(tNow("providers.contextWindowAria", { index: 3 })) as HTMLInputElement).value).toBe("256000");
		expect((screen.getByLabelText(tNow("providers.maxTokensAria", { index: 3 })) as HTMLInputElement).value).toBe("16384");

		// Save and verify provider default window was NOT overwritten and ompModelsSetContextWindows was NOT called
		fireEvent.click(screen.getByRole("button", { name: tNow("common.save") }));
		await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
		expect(upsert.mock.calls[0][0]).toMatchObject({
			id: "custom-gw",
			models: [
				{ id: "gpt-4o", contextWindow: 256000, maxTokens: 16384 },
				{ id: "claude-3-7-sonnet", contextWindow: 200000, maxTokens: 8192 },
				{ id: "gpt-4.1", contextWindow: 256000, maxTokens: 16384 },
			],
		});
		expect(ompModelsSetContextWindows).not.toHaveBeenCalled();
		expect(loadProviderWindows()["custom-gw"]).toBe(200000);
	});

	it("scopes batch clear to matched rows only when filtering", () => {
		const provider = makeProvider({
			models: [
				{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096 },
				{ id: "claude-3-7-sonnet", contextWindow: 200000, maxTokens: 8192 },
			],
		});
		render(<ProviderDialog target={{ mode: "edit", row: provider }} onClose={vi.fn()} />);

		const searchInput = screen.getByLabelText(tNow("providers.modelSearchAria"));
		fireEvent.change(searchInput, { target: { value: "gpt" } });

		fireEvent.click(screen.getByRole("button", { name: tNow("providers.batchClearBtn") }));

		fireEvent.change(searchInput, { target: { value: "" } });
		expect((screen.getByLabelText(tNow("providers.contextWindowAria", { index: 1 })) as HTMLInputElement).value).toBe("");
		expect((screen.getByLabelText(tNow("providers.maxTokensAria", { index: 1 })) as HTMLInputElement).value).toBe("");
		expect((screen.getByLabelText(tNow("providers.contextWindowAria", { index: 2 })) as HTMLInputElement).value).toBe("200000");
		expect((screen.getByLabelText(tNow("providers.maxTokensAria", { index: 2 })) as HTMLInputElement).value).toBe("8192");
	});

	it("probes only filtered models and shows matched count on the probe button", async () => {
		render(<ProviderDialog target={{ mode: "edit", row: makeProvider() }} onClose={vi.fn()} />);

		const searchInput = screen.getByLabelText(tNow("providers.modelSearchAria"));
		fireEvent.change(searchInput, { target: { value: "gpt" } });

		const probeBtn = screen.getByRole("button", { name: tNow("providers.probeMatchedBtn", { count: 2 }) });
		fireEvent.click(probeBtn);

		await waitFor(() => expect(runModelTest).toHaveBeenCalledTimes(2));
		expect(runModelTest).toHaveBeenCalledWith("custom-gw", "gpt-4o");
		expect(runModelTest).toHaveBeenCalledWith("custom-gw", "gpt-4.1");
		expect(runModelTest).not.toHaveBeenCalledWith("custom-gw", "claude-3-7-sonnet");
	});

	it("resets model search when dialog target switches to another provider", () => {
		const { rerender } = render(
			<ProviderDialog target={{ mode: "edit", row: makeProvider({ id: "provider-a" }) }} onClose={vi.fn()} />,
		);
		const searchInput = screen.getByLabelText(tNow("providers.modelSearchAria")) as HTMLInputElement;
		fireEvent.change(searchInput, { target: { value: "gpt" } });
		expect(searchInput.value).toBe("gpt");

		rerender(
			<ProviderDialog target={{ mode: "edit", row: makeProvider({ id: "provider-b" }) }} onClose={vi.fn()} />,
		);
		expect((screen.getByLabelText(tNow("providers.modelSearchAria")) as HTMLInputElement).value).toBe("");
	});

	it("locks protocol when a preset determines it, shows blur validation, and allows undoing preset switch with unsaved edits", () => {
		render(<ProviderDialog target={{ mode: "add" }} onClose={vi.fn()} />);

		const nameInput = screen.getByLabelText(tNow("providers.nameLabel")) as HTMLInputElement;
		fireEvent.focus(nameInput);
		fireEvent.blur(nameInput);
		expect(screen.getByText(tNow("providers.missingFieldsError", { fields: tNow("providers.fieldName") }))).toBeTruthy();

		// User enters unsaved edits, then picks a preset (Anthropic) -> protocol locks + Undo banner appears.
		fireEvent.change(nameInput, { target: { value: "my-custom-provider" } });
		fireEvent.click(screen.getByRole("button", { name: tNow("providers.startFromPreset") }));
		fireEvent.click(screen.getByRole("button", { name: "Anthropic" }));

		expect(nameInput.value).toBe("anthropic");
		expect(screen.getByText(tNow("providers.presetProtocolLocked"))).toBeTruthy();
		expect(screen.getByText(tNow("providers.presetSwitchedNotice", { name: "Anthropic" }))).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: tNow("common.undo") }));
		expect(nameInput.value).toBe("my-custom-provider");
		expect(screen.queryByText(tNow("providers.presetProtocolLocked"))).toBeNull();
	});
});
