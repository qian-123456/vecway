// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModelCatalog } from "../../stores/modelCatalog";
import { useModelKindCatalog } from "../../stores/modelKinds";
import { buildAssignmentRows, type AssignmentScope } from "./agentModelAssignments";
import { type AssignmentContext, RoleAssignmentTable } from "./ModelRoleTables";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.reject(new Error("no tauri"))) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(() => Promise.resolve("0.0.0-test")) }));

function renderTable({
	globalRoles = { default: "openai-codex/gpt-5.4-codex-extra-long-model:high" },
	projectRoles = {},
	scope = "global",
}: {
	globalRoles?: Record<string, string>;
	projectRoles?: Record<string, string>;
	scope?: AssignmentScope;
} = {}) {
	const rows = buildAssignmentRows({
		global: { modelRoles: globalRoles, agentModelOverrides: {} },
		project: scope === "project" ? { modelRoles: projectRoles, agentModelOverrides: {} } : null,
		agents: [],
		sessionModel: null,
	});
	const ctx: AssignmentContext = {
		scope,
		models: [{ provider: "openai-codex", id: "gpt-5.4-codex-extra-long-model", name: "gpt-5.4-codex-extra-long-model", thinking: ["low", "high"] }],
		projectName: "alpha",
		sessionSelected: false,
		globalPath: "/home/u/.omp/config.yml",
		projectPath: scope === "project" ? "/repo/alpha/.omp/config.yml" : null,
		projectCwd: scope === "project" ? "/repo/alpha" : null,
		busy: false,
		roles: scope === "project" ? { ...globalRoles, ...projectRoles } : globalRoles,
		roleUsers: new Map(),
		write: vi.fn(async () => {}),
	};
	return render(<RoleAssignmentTable rows={rows} query="" ctx={ctx} />);
}

describe("RoleAssignmentTable narrow-container layout", () => {
	beforeEach(() => {
		useModelCatalog.setState({ models: [], loading: false, refresh: async () => {} });
		useModelKindCatalog.setState({ entries: [], kindBySelector: new Map(), error: null, loading: false, load: async () => {} });
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("marks the table as an @container and stacks role name above model summary below 560px", () => {
		renderTable({
			scope: "project",
			globalRoles: { default: "openai-codex/gpt-5.4-codex-extra-long-model:high" },
			projectRoles: {},
		});

		const table = screen.getByTestId("role-table");
		expect(table.className.split(/\s+/)).toContain("@container");

		const defaultRow = table.querySelector<HTMLElement>('[data-row-name="default"]')!;
		const rowHeader = defaultRow.querySelector<HTMLElement>('[role="button"]')!;
		const contentStack = rowHeader.querySelector<HTMLElement>("div.flex-col")!;

		// Stacked two-line layout when narrow, horizontal single-line only at @[560px].
		expect(contentStack.className).toContain("flex-col");
		expect(contentStack.className).toContain("@[560px]:flex-row");
		expect(contentStack.className).toContain("min-w-0");
		expect(contentStack.className).toContain("flex-1");

		// Model name keeps a readable minimum width and wraps cleanly instead of collapsing to single-char columns.
		const modelSpan = defaultRow.querySelector<HTMLElement>("span.font-mono.text-\\[12px\\]:not(.font-semibold)")!;
		expect(modelSpan.textContent).toContain("openai-codex/gpt-5.4-codex-extra-long-model");
		expect(modelSpan.className).toContain("min-w-[140px]");
		expect(modelSpan.className).toContain("flex-1");
		expect(modelSpan.className).toContain("break-words");
		expect(modelSpan.className).toContain("[overflow-wrap:anywhere]");
		expect(modelSpan.className).not.toContain("w-72");

		// Summary wrapper wraps on narrow containers and only switches to nowrap at @[560px].
		const summaryBox = modelSpan.parentElement!;
		expect(summaryBox.className).toContain("flex-wrap");
		expect(summaryBox.className).toContain("@[560px]:flex-nowrap");

		// Metadata chips/thinking level stay single-line (no vertical char wrapping).
		const thinkingEl = defaultRow.querySelector<HTMLElement>('[title="high"]')!;
		expect(thinkingEl.className).toContain("whitespace-nowrap");
	});

	it("keeps expanded row editor controls fluid within narrow panes", () => {
		renderTable();
		const table = screen.getByTestId("role-table");
		const defaultRow = table.querySelector<HTMLElement>('[data-row-name="default"]')!;
		fireEvent.click(defaultRow.querySelector('[role="button"]')!);

		const select = defaultRow.querySelector<HTMLSelectElement>("select")!;
		const selectWrapper = select.closest<HTMLElement>("div.max-w-\\[340px\\]")!;
		const classes = selectWrapper.className.split(/\s+/);
		expect(classes).toContain("w-full");
		expect(classes).toContain("max-w-[340px]");
		expect(classes).not.toContain("w-[340px]");
	});
});
