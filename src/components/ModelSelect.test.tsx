// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "../lib/models";
import * as settingsTargets from "../features/settings/settingsTargets";
import { useOmpConfigStore } from "../features/settings/ompConfigStore";
import { useModelCatalog, useModelOptions } from "../stores/modelCatalog";
import { ModelMenuContent, ModelSelect } from "./ModelSelect";
import { useModelSelectPrefs } from "./modelSelectPrefs";

const model = (provider: string, id: string): ModelOption => ({
	provider,
	id,
	name: id,
	thinking: [],
	contextWindow: null,
});
const MODELS = [
	model("anthropic", "claude-opus"),
	model("anthropic", "claude-sonnet"),
	model("openai", "gpt-5"),
	model("openai", "gpt-5-mini"),
	model("deepseek", "deepseek-flash"),
	model("deepseek", "deepseek-pro"),
];
const ROLE_EXTRAS = [
	{ value: "default", label: "主力模型" },
	{ value: "slow", label: "深度模型" },
];

beforeEach(() => {
	localStorage.clear();
	useModelSelectPrefs.setState({ recent: [], dismissedGuides: [] });
	useOmpConfigStore.setState({ entries: [], loaded: true, loading: false, load: async () => {} });
	useModelCatalog.setState({
		models: null,
		loading: false,
		status: "idle",
		error: null,
		unavailable: [],
		warnings: [],
		refresh: async () => {},
		refreshOnline: async () => {},
	});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("ModelMenuContent groups", () => {
	it("shows a failed no-cache read instead of an endless loading indicator", () => {
		useModelCatalog.setState({ status: "failed", error: "模型目录刷新失败：MODEL_CATALOG_EXIT_FAILED" });
		render(<ModelMenuContent models={null} onSelect={() => {}} />);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("模型列表加载失败");
		fireEvent.click(within(alert).getByText("查看错误详情"));
		expect(alert.textContent).toContain("MODEL_CATALOG_EXIT_FAILED");
		expect(screen.getByRole("button", { name: "刷新模型列表" })).toBeTruthy();
		expect(screen.queryByText("加载模型列表中…")).toBeNull();
	});
	it("does not render permanent availability-unverified or keyboard-tip footer bars", () => {
		useModelCatalog.setState({ status: "unverified", models: MODELS });
		render(<ModelMenuContent catalogManaged models={MODELS} onSelect={() => {}} />);
		expect(screen.queryByText(/可用性未验证|Availability unverified/)).toBeNull();
		expect(screen.queryByText(/切换分组|switch group/)).toBeNull();
	});


	it("puts unavailable rows after selectable rows and blocks click, Enter and custom selection", () => {
		const onSelect = vi.fn();
		useModelCatalog.setState({
			status: "unverified",
			unavailable: [MODELS[0]!, MODELS[4]!],
		});
		render(<ModelMenuContent catalogManaged models={[MODELS[1]!, MODELS[2]!]} allowCustom onSelect={onSelect} />);
		const ready = screen.getByRole("button", { name: "claude-sonnet" });
		const old = screen.getByRole("button", { name: "claude-opus 暂不可选" });
		expect((old as HTMLButtonElement).disabled).toBe(true);
		expect(ready.compareDocumentPosition(old) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		fireEvent.click(old);
		expect(onSelect).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /deepseek/ })).toBeTruthy();

		const search = screen.getByRole("textbox");
		fireEvent.change(search, { target: { value: "anthropic/claude-opus" } });
		expect(screen.getByRole("button", { name: /claude-opus 暂不可选/ })).toBeTruthy();
		fireEvent.keyDown(search, { key: "Enter" });
		expect(onSelect).not.toHaveBeenCalled();
		expect(screen.queryByText("使用本次列表")).toBeNull();
	});

	it("shows a concrete provider warning separately and offers a recovery action", () => {
		const openSettings = vi.spyOn(settingsTargets, "openSettingsTarget").mockImplementation(() => {});
		useModelCatalog.setState({
			status: "unverified",
			unavailable: [MODELS[0]!],
			warnings: [{ kind: "authenticationRequired", provider: "anthropic" }],
		});
		render(<ModelMenuContent catalogManaged models={[]} onSelect={() => {}} />);
		expect(screen.getByRole("status").textContent).toContain("anthropic 需要验证身份");
		fireEvent.click(screen.getByRole("button", { name: "管理模型供应商" }));
		expect(openSettings).toHaveBeenCalledWith("providers");
	});

	it("keeps the previous snapshot visible but unselectable when the entire read fails", () => {
		const onSelect = vi.fn();
		useModelCatalog.setState({ status: "stale", error: "MODEL_CATALOG_TIMEOUT" });
		render(<ModelMenuContent catalogManaged models={[MODELS[0]!]} currentValue="anthropic/claude-opus" onSelect={onSelect} />);
		const row = screen.getByRole("button", { name: /claude-opus 暂不可选/ });
		expect((row as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole("alert").textContent).toContain("模型列表加载失败");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it.each(["claude-opus", "anthropic/claude-opus", "claude-opus:high", "anthropic/claude-opus:high"])(
		"blocks the known-unavailable custom selector %s",
		(selector) => {
			const onSelect = vi.fn();
			useModelCatalog.setState({ status: "unverified", unavailable: [MODELS[0]!] });
			render(<ModelMenuContent catalogManaged models={[MODELS[1]!]} roles={{}} allowCustom onSelect={onSelect} />);
			const search = screen.getByRole("textbox");
			fireEvent.change(search, { target: { value: selector } });
			expect(screen.queryByRole("button", { name: /作为模型标识/ })).toBeNull();
			fireEvent.keyDown(search, { key: "ArrowDown" });
			fireEvent.keyDown(search, { key: "Enter" });
			expect(onSelect).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ value: "slow", roles: { slow: "anthropic/claude-opus:high" } },
		{ value: "@slow:high", roles: { slow: "@review", review: "@deep", deep: "claude-opus:low" } },
		{ value: "slow", roles: { default: "anthropic/claude-opus:high" } },
		{ value: "@default", roles: { default: "anthropic/claude-opus" } },
		{ value: "@review:high", roles: { review: "@deep", deep: "anthropic/claude-opus:low" } },
	])("disables an extra resolving to an unavailable model: $value / $roles", ({ value, roles }) => {
		const onSelect = vi.fn();
		useModelCatalog.setState({ status: "unverified", unavailable: [MODELS[0]!] });
		render(
			<ModelMenuContent catalogManaged models={[MODELS[1]!]} roles={roles}
				extras={[{ value, label: "配置角色" }]} onSelect={onSelect} />,
		);
		const row = screen.getByRole("button", { name: /配置角色.*暂不可选/ });
		expect((row as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(row);
		const search = screen.getByRole("textbox");
		fireEvent.keyDown(search, { key: "ArrowDown" });
		fireEvent.keyDown(search, { key: "Enter" });
		expect(onSelect).not.toHaveBeenCalled();
	});

	it.each(["slow", "@slow", "slow:high", "@slow:high", "@review:high", "default", "@default:high"])(
		"blocks a custom role resolving to an unavailable model: %s",
		(selector) => {
			const onSelect = vi.fn();
			useModelCatalog.setState({ status: "unverified", unavailable: [MODELS[0]!] });
			render(
				<ModelMenuContent catalogManaged models={[MODELS[1]!]} allowCustom
					roles={{ slow: "@review", review: "@deep", deep: "anthropic/claude-opus:low", default: "claude-opus" }}
					onSelect={onSelect} />,
			);
			const search = screen.getByRole("textbox");
			fireEvent.change(search, { target: { value: selector } });
			expect(screen.queryByRole("button", { name: /作为模型标识/ })).toBeNull();
			fireEvent.keyDown(search, { key: "Enter" });
			expect(onSelect).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ selector: "@slow:high", roles: { slow: "@review", review: "anthropic/claude-sonnet" } },
		{ selector: "slow", roles: { default: "anthropic/claude-sonnet" } },
		{ selector: "default", roles: {} },
		{ selector: "@slow", roles: {} },
		{ selector: "@unknown", roles: {} },
		{ selector: "@review", roles: { review: "example/unknown-model" } },
	])("preserves available, automatic and unknown role picks: $selector / $roles", ({ selector, roles }) => {
		const onSelect = vi.fn();
		useModelCatalog.setState({ status: "unverified", unavailable: [MODELS[0]!] });
		render(<ModelMenuContent catalogManaged models={[MODELS[1]!]} roles={roles} allowCustom onSelect={onSelect} />);
		const search = screen.getByRole("textbox");
		fireEvent.change(search, { target: { value: selector } });
		fireEvent.click(screen.getByRole("button", { name: /作为模型标识/ }));
		expect(onSelect).toHaveBeenCalledWith(selector);
	});

	it("keeps an available role extra selectable while skipping an unavailable extra with the keyboard", () => {
		const onSelect = vi.fn();
		useModelCatalog.setState({ status: "unverified", unavailable: [MODELS[0]!] });
		render(
			<ModelMenuContent catalogManaged models={[MODELS[1]!]} extras={ROLE_EXTRAS}
				roles={{ default: "anthropic/claude-opus", slow: "anthropic/claude-sonnet" }} onSelect={onSelect} />,
		);
		expect((screen.getByRole("button", { name: /主力模型.*暂不可选/ }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		expect(onSelect).toHaveBeenCalledWith("slow");
	});

	it("waits for role configuration before allowing extras or custom aliases", () => {
		const onSelect = vi.fn();
		useOmpConfigStore.setState({ loaded: false });
		useModelCatalog.setState({ status: "unverified", unavailable: [MODELS[0]!] });
		render(
			<ModelMenuContent catalogManaged models={[MODELS[1]!]} allowCustom
				extras={[{ value: "slow", label: "深度模型" }]} onSelect={onSelect} />,
		);
		const pending = screen.getByRole("button", { name: /深度模型/ });
		expect((pending as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(pending);
		const search = screen.getByRole("textbox");
		fireEvent.change(search, { target: { value: "@review:high" } });
		expect(screen.queryByRole("button", { name: /作为模型标识/ })).toBeNull();
		fireEvent.keyDown(search, { key: "Enter" });
		expect(onSelect).not.toHaveBeenCalled();
		act(() => useOmpConfigStore.setState({
			loaded: true,
			entries: [{ key: "modelRoles", value: { slow: "@review", review: "anthropic/claude-opus" }, valueType: "record", description: "", redacted: false, tab: "models" }],
		}));
		expect(screen.queryByRole("button", { name: /作为模型标识/ })).toBeNull();
		fireEvent.keyDown(search, { key: "Enter" });
		fireEvent.change(search, { target: { value: "" } });
		expect((screen.getByRole("button", { name: /深度模型.*暂不可选/ }) as HTMLButtonElement).disabled).toBe(true);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("keeps filtered service lists and custom selectors independent of chat history", () => {
		const onSelect = vi.fn();
		useModelCatalog.setState({ status: "stale", unavailable: [MODELS[0]!] });
		render(
			<ModelMenuContent models={[model("web", "duckduckgo")]} allowCustom
				roles={{ slow: "anthropic/claude-opus" }} onSelect={onSelect} />,
		);
		expect(screen.queryByText("暂不可选")).toBeNull();
		expect(screen.queryByRole("button", { name: /anthropic/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "duckduckgo" }));
		expect(onSelect).toHaveBeenLastCalledWith("web/duckduckgo");
		const search = screen.getByRole("textbox");
		for (const selector of ["anthropic/claude-opus:high", "@slow:high", "speech/custom"]) {
			fireEvent.change(search, { target: { value: selector } });
			fireEvent.click(screen.getByRole("button", { name: /作为模型标识/ }));
			expect(onSelect).toHaveBeenLastCalledWith(selector);
		}
	});

	it("finds and selects a newly registered model in the same search after manual refresh", async () => {
		const onSelect = vi.fn();
		useModelCatalog.setState({ models: MODELS.slice(0, 1) });
		const refreshOnline = vi.fn(async () => {
			useModelCatalog.setState({
				models: [...MODELS.slice(0, 1), model("example", "new-model")],
				status: "unverified",
			});
		});
		useModelCatalog.setState({ refreshOnline });
		function SharedPicker() {
			const models = useModelOptions();
			return <ModelMenuContent catalogManaged models={models} onSelect={onSelect} />;
		}
		render(<SharedPicker />);
		const input = screen.getByPlaceholderText(/搜索模型/);
		fireEvent.change(input, { target: { value: "example/new-model" } });
		expect(screen.getByText("无匹配模型")).toBeTruthy();
		const refresh = screen.getByRole("button", { name: "刷新模型列表" });
		fireEvent.click(refresh);
		expect(refreshOnline).toHaveBeenCalledOnce();
		const result = await screen.findByRole("button", { name: /new-model/ });
		expect((input as HTMLInputElement).value).toBe("example/new-model");
		fireEvent.keyDown(refresh, { key: "Enter" });
		expect(onSelect).not.toHaveBeenCalled();
		fireEvent.click(result);
		expect(onSelect).toHaveBeenCalledWith("example/new-model");
	});

	it("lists role extras under their own 角色 tab, not under 常用", () => {
		const onSelect = vi.fn();
		render(
			<ModelMenuContent
				models={MODELS}
				onSelect={onSelect}
				extras={[{ value: "", label: "使用默认模型" }, ...ROLE_EXTRAS]}
				roles={{ default: "anthropic/claude-opus:high" }}
			/>,
		);
		// 常用 holds the plain extra only.
		expect(screen.getByText("使用默认模型")).toBeTruthy();
		expect(screen.queryByText(/主力模型/)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^角色/ }));
		fireEvent.click(screen.getByRole("button", { name: /主力模型/ }));
		expect(onSelect).toHaveBeenCalledWith("default");
	});

	it("has no 角色 tab when the caller passes no role extras", () => {
		render(<ModelMenuContent models={MODELS} onSelect={() => {}} />);
		expect(screen.queryByRole("button", { name: /^角色/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /常用/ })).toBeNull();
	});

	it("opens on the role tab when the current value is a role", () => {
		render(
			<ModelMenuContent
				models={MODELS}
				currentValue="slow"
				onSelect={() => {}}
				extras={ROLE_EXTRAS}
				roles={{ default: "anthropic/claude-opus", slow: "openai/gpt-5" }}
			/>,
		);
		expect(screen.getByRole("button", { name: /深度模型/ })).toBeTruthy();
	});
});

describe("ModelMenuContent complete readable catalog", () => {
	it("keeps every provider reachable and displays the full model ID", () => {
		const models = Array.from({ length: 45 }, (_, i) => ({
			...model(`long-configured-provider-${i}`, `opaque-model-id-${i}`),
			name: `Complete configured model name ${i}`,
		}));
		const onSelect = vi.fn();
		const { container } = render(<ModelMenuContent models={models} onSelect={onSelect} />);
		expect(container.querySelectorAll("[data-model-group]")).toHaveLength(models.length);
		for (const entry of models) {
			const providerButton = screen.getByText(entry.provider, { exact: true }).closest("button");
			expect(providerButton).not.toBeNull();
			fireEvent.click(providerButton!);
			expect(screen.queryByText(entry.name)).toBeNull();
			expect(screen.getByText(entry.id)).toBeTruthy();
		}
		fireEvent.click(screen.getByRole("button", { name: "opaque-model-id-44" }));
		expect(onSelect).toHaveBeenLastCalledWith("long-configured-provider-44/opaque-model-id-44");
	});

	it("shows distinct raw IDs even when the models share a display name", () => {
		const onSelect = vi.fn();
		const models = ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite"].map((id) => ({
			...model("google-antigravity", id),
			name: "Gemini 3.5 Flash Lite",
		}));
		render(<ModelMenuContent models={models} onSelect={onSelect} />);
		expect(screen.queryByText("Gemini 3.5 Flash Lite")).toBeNull();
		for (const entry of models) {
			const row = screen.getByRole("button", { name: entry.id });
			expect(row.getAttribute("title")).toBe(`google-antigravity/${entry.id}`);
			fireEvent.click(row);
			expect(onSelect).toHaveBeenLastCalledWith(`google-antigravity/${entry.id}`);
		}
	});

	it("searches full provider, display name and model ID without dropping entries", () => {
		const models = Array.from({ length: 45 }, (_, i) => ({
			...model("custom-provider", `opaque-model-${i}`),
			name: `Readable model name ${i}`,
		}));
		const onSelect = vi.fn();
		const { container } = render(<ModelMenuContent models={models} onSelect={onSelect} />);
		const search = screen.getByRole("textbox");
		fireEvent.change(search, { target: { value: "custom-provider" } });
		expect(container.querySelectorAll("[data-model-key]")).toHaveLength(models.length);
		fireEvent.change(search, { target: { value: "Readable model name 44" } });
		expect(screen.getByText("opaque-model-44")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "opaque-model-44 custom-provider" }));
		expect(onSelect).toHaveBeenLastCalledWith("custom-provider/opaque-model-44");
		fireEvent.change(search, { target: { value: "opaque-model-0" } });
		expect(screen.getByText("opaque-model-0")).toBeTruthy();
	});
});

describe("ModelMenuContent selection persistence", () => {
    it("opens a favorite current model in its true provider group", () => {
        useModelSelectPrefs.setState({ recent: ["openai/gpt-5"] });
        const { container } = render(
            <ModelMenuContent models={MODELS} currentValue="openai/gpt-5" onSelect={() => {}} />,
        );
        const provider = container.querySelector('[data-model-group="p:openai"]');
        expect(provider?.className).toContain("bg-[var(--bg-active-fill)]");
        expect(container.querySelector('[data-model-key="openai/gpt-5"]')).toBeTruthy();
    });

    it("keeps a hand-selected provider when the catalog refreshes", () => {
        const { container, rerender } = render(
            <ModelMenuContent models={MODELS} currentValue="anthropic/claude-opus" onSelect={() => {}} />,
        );
        fireEvent.click(container.querySelector('[data-model-group="p:deepseek"]') as HTMLElement);
        rerender(
            <ModelMenuContent
                models={[...MODELS, model("zeta", "new-model")]}
                currentValue="anthropic/claude-opus"
                onSelect={() => {}}
            />,
        );
        expect(container.querySelector('[data-model-key="deepseek/deepseek-flash"]')).toBeTruthy();
    });
  });

it("keeps the search input and caption stable across catalog loading", () => {
    render(
        <ModelMenuContent models={MODELS} caption="模型" onSelect={() => {}} />,
    );
    const input = screen.getByPlaceholderText(/搜索模型/);
    fireEvent.change(input, { target: { value: "gpt" } });
    act(() => useModelCatalog.setState({ loading: true }));
    expect(screen.getByText("模型")).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "正在刷新模型列表" });
    expect(refresh.parentElement?.querySelector("input")).toBe(input);
    expect(input.parentElement?.nextElementSibling).toBe(refresh);
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByPlaceholderText(/搜索模型/)).toBe(input);
    expect((input as HTMLInputElement).value).toBe("gpt");
    act(() => useModelCatalog.setState({ loading: false }));
    expect(screen.getByPlaceholderText(/搜索模型/)).toBe(input);
});

describe("ModelMenuContent keyboard", () => {
	it("moves the highlight with arrows and picks with Enter", () => {
		const onSelect = vi.fn();
		render(<ModelMenuContent models={MODELS} onSelect={onSelect} />);
		const box = screen.getByPlaceholderText(/搜索模型/);
		fireEvent.change(box, { target: { value: "gpt" } });
		fireEvent.keyDown(box, { key: "ArrowDown" });
		fireEvent.keyDown(box, { key: "Enter" });
		expect(onSelect).toHaveBeenCalledWith("openai/gpt-5-mini");
	});

	it("Enter in search picks the first hit without arrow keys", () => {
		const onSelect = vi.fn();
		render(<ModelMenuContent models={MODELS} onSelect={onSelect} />);
		const box = screen.getByPlaceholderText(/搜索模型/);
		fireEvent.change(box, { target: { value: "deepseek" } });
		fireEvent.keyDown(box, { key: "Enter" });
		expect(onSelect).toHaveBeenCalledWith("deepseek/deepseek-flash");
	});

	it("ArrowRight switches to the next group", () => {
		render(<ModelMenuContent models={MODELS} onSelect={() => {}} />);
		const box = screen.getByPlaceholderText(/搜索模型/);
		// First provider group is anthropic; step to openai.
		fireEvent.keyDown(box, { key: "ArrowRight" });
		expect(screen.getByRole("button", { name: "gpt-5-mini" })).toBeTruthy();
	});
});

describe("ModelMenuContent recent", () => {
	it("removes a recent entry immediately and restores it on undo", () => {
		useModelSelectPrefs.setState({ recent: ["openai/gpt-5", "anthropic/claude-opus"] });
		render(<ModelMenuContent models={MODELS} onSelect={() => {}} />);
		fireEvent.click(screen.getAllByRole("button", { name: "移出最近使用" })[0]);
		expect(useModelSelectPrefs.getState().recent).toEqual(["anthropic/claude-opus"]);

		fireEvent.click(screen.getByRole("button", { name: "撤销" }));
		expect(useModelSelectPrefs.getState().recent).toEqual(["openai/gpt-5", "anthropic/claude-opus"]);
	});
});

describe("ModelSelect thinking pill and level separation", () => {
	it("strips level suffix from the model button and displays level on thinking chip", () => {
		const onSelect = vi.fn();
		const models: ModelOption[] = [
			{
				provider: "tiancai-smart",
				id: "gpt-6.1-sol",
				name: "GPT 6.1 Sol",
				thinking: ["low", "high", "xhigh"],
				contextWindow: null,
			},
		];
		render(
			<ModelSelect
				models={models}
				label="tiancai-smart/gpt-6.1-sol:xhigh"
				currentValue="tiancai-smart/gpt-6.1-sol:xhigh"
				thinking
				onSelect={onSelect}
			/>,
		);
		expect(screen.getByRole("button", { name: "tiancai-smart/gpt-6.1-sol" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /:xhigh/ })).toBeNull();
		expect(screen.getByText("xhigh")).toBeTruthy();
	});
	it.each(["stale", "failed", "missing"] as const)("blocks an open thinking picker when its managed model becomes %s", (state) => {
		vi.stubGlobal("ResizeObserver", class {
			observe() {}
			unobserve() {}
			disconnect() {}
		});
		const onSelect = vi.fn();
		const current = { ...MODELS[0]!, thinking: ["low", "high"] };
		render(<ModelSelect catalogManaged models={[current]} currentValue="anthropic/claude-opus:high"
			label="claude-opus" thinking onSelect={onSelect} />);
		fireEvent.click(screen.getByText("high").closest("button")!);
		fireEvent.click(screen.getByRole("button", { name: /: High$/ }));
		const low = screen.getByRole("menuitemradio", { name: /^low/ });
		act(() => useModelCatalog.setState({
			status: state === "missing" ? "unverified" : state,
			unavailable: state === "missing" ? [current] : [],
		}));
		expect(screen.queryByRole("menuitemradio")).toBeNull();
		expect(screen.queryByText("high")).toBeNull();
		fireEvent.click(low);
		expect(onSelect).not.toHaveBeenCalled();
	});
});
