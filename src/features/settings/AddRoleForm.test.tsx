// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModelSelectPrefs } from "../../components/modelSelectPrefs";
import { useModelCatalog, useModelOptions } from "../../stores/modelCatalog";
import type { AssignmentContext } from "./ModelRoleTables";
import { AddRoleForm } from "./AddRoleForm";

beforeEach(() => {
	localStorage.clear();
	useModelSelectPrefs.setState({ recent: [], dismissedGuides: [] });
	useModelCatalog.setState({ models: [], unavailable: [], status: "unverified", loading: false, error: null, warnings: [], refresh: async () => {} });
	vi.stubGlobal("ResizeObserver", class {
		observe() {}
		unobserve() {}
		disconnect() {}
	});
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("AddRoleForm IME", () => {
	it("does not submit on the Enter that confirms an IME candidate", () => {
		const onCancel = vi.fn();
		const ctx = { scope: "global", busy: false, projectName: "" } as never;
		render(<AddRoleForm ctx={ctx} existing={new Set()} onAdded={vi.fn()} onCancel={onCancel} />);
		const input = screen.getByLabelText("新角色名称");
		fireEvent.change(input, { target: { value: "ni" } });
		fireEvent.compositionStart(input);
		fireEvent.keyDown(input, { key: "Enter", isComposing: true });
		// Submitting an unpicked model would surface a validation error.
		expect(screen.queryByRole("alert")).toBeNull();
		fireEvent.compositionEnd(input);
	});
});

describe("AddRoleForm catalog selection boundary", () => {
	it.each(["unverified", "stale"] as const)("does not save missing or stale models through a custom selector (%s)", async (status) => {
		const available = { provider: "anthropic", id: "available", name: "available" };
		const missing = { provider: "anthropic", id: "missing", name: "missing" };
		const write = vi.fn().mockResolvedValue(undefined);
		const onAdded = vi.fn();
		useModelCatalog.setState({
			models: status === "stale" ? [available, missing] : [available],
			unavailable: [missing], status,
			error: status === "stale" ? "MODEL_CATALOG_TIMEOUT" : null,
		});
		function Form() {
			const models = useModelOptions();
			const ctx: AssignmentContext = {
				scope: "global", models, busy: false, projectName: "", sessionSelected: false,
				globalPath: "", projectPath: null, projectCwd: null, write,
				roles: { slow: "@review", review: "anthropic/missing:low" }, roleUsers: new Map(),
			};
			return <AddRoleForm ctx={ctx} existing={new Set()} onAdded={onAdded} onCancel={vi.fn()} />;
		}
		render(<Form />);
		fireEvent.change(screen.getByLabelText("新角色名称"), { target: { value: "reviewer" } });
		fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
		const search = screen.getByRole("textbox", { name: "搜索模型" });
		fireEvent.change(search, { target: { value: "anthropic/missing" } });
		const old = screen.getByRole("button", { name: /missing 暂不可选/ });
		expect((old as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(old);
		fireEvent.keyDown(search, { key: "Enter" });
		for (const selector of ["anthropic/missing:high", "@slow:high"]) {
			fireEvent.change(search, { target: { value: selector } });
			expect(screen.queryByRole("button", { name: /作为模型标识/ })).toBeNull();
			fireEvent.keyDown(search, { key: "Enter" });
		}
		fireEvent.click(screen.getByRole("button", { name: "添加" }));
		expect(write).not.toHaveBeenCalled();
		expect(onAdded).not.toHaveBeenCalled();
		act(() => useModelCatalog.setState({ models: [available], status: "unverified", error: null }));
		fireEvent.change(search, { target: { value: "anthropic/available" } });
		fireEvent.click(screen.getByRole("button", { name: "available anthropic" }));
		fireEvent.click(screen.getByRole("button", { name: "添加" }));
		await waitFor(() => expect(write).toHaveBeenCalledWith("global", "modelRoles", "reviewer", "anthropic/available"));
		await waitFor(() => expect(onAdded).toHaveBeenCalledWith("reviewer"));
		expect(write).toHaveBeenCalledTimes(1);
	});
});
