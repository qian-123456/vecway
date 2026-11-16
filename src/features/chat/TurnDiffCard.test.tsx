// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolResultInfo, TurnCheckpoint } from "../../lib/contracts";
import type { StepShape } from "./ExecutionDisclosure";

vi.mock("../../lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/ipc")>()),
	gitDiff: vi.fn(async () => "@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n export { a };"),
}));

vi.mock("../../stores/filePreview", () => ({
	openFileLink: vi.fn(async () => {}),
}));

import { TurnDiffCard } from "./TurnDiffCard";
import { collectTurnDiffSummary } from "./turnDiffs";

afterEach(cleanup);

const makeToolStep = (
	id: string,
	name: string,
	args: Record<string, unknown>,
	result?: ToolResultInfo,
): StepShape => ({
	id: `step-${id}`,
	kind: "tool",
	call: { id, name, args, intent: null },
	result,
});

describe("TurnDiffCard & collectTurnDiffSummary", () => {
	it("renders nothing when a turn only ran read/search tools without file changes", () => {
		const steps: StepShape[] = [
			makeToolStep("c1", "read", { path: "src/app.tsx" }, {
				toolCallId: "c1",
				toolName: "read",
				text: "1: export function App() {}",
				isError: false,
				details: null,
			}),
		];
		const { container } = render(
			<TurnDiffCard sessionId="s1" steps={steps} sessionCwd="/repo" isLatestTurn />,
		);
		expect(container.querySelector("[data-turn-diff-card]")).toBeNull();
	});

	it("aggregates multiple edits, synthesizes new-file write diffs, and auto-expands single-file card", () => {
		const diff1 = "@@ -10,3 +10,4 @@\n const x = 1;\n-const y = 2;\n+const y = 3;\n+const z = 4;";
		const steps: StepShape[] = [
			makeToolStep("c1", "edit", { path: "/repo/src/MessageList.tsx" }, {
				toolCallId: "c1",
				toolName: "edit",
				text: "edited",
				isError: false,
				details: { diff: diff1 },
			}),
		];
		const { container } = render(
			<TurnDiffCard sessionId="s1" steps={steps} sessionCwd="/repo" isLatestTurn />,
		);
		const card = container.querySelector("[data-turn-diff-card]");
		expect(card).not.toBeNull();
		expect(card?.textContent).toContain("1 个文件已更改");
		expect(card?.textContent).toContain("+2");
		expect(card?.textContent).toContain("−1");

		const headerBtn = screen.getByRole("button", { name: /1 个文件已更改/ });
		expect(headerBtn.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(headerBtn);
		expect(headerBtn.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("src/MessageList.tsx")).toBeTruthy();
		// Single-file card auto-expands its inline DiffView on first open
		expect(card?.textContent).toContain("const z = 4;");
	});

	it("supports non-exclusive multi-file expansion, expand/collapse all, and checkpoint status/undone merge", () => {
		const steps: StepShape[] = [
			makeToolStep("c1", "write", { path: "/repo/src/newFile.ts", content: "export const a = 1;\nexport const b = 2;\n" }, {
				toolCallId: "c1",
				toolName: "write",
				text: "created",
				isError: false,
				details: null,
			}),
			makeToolStep("c2", "edit", { path: "/repo/src/oldFile.ts" }, {
				toolCallId: "c2",
				toolName: "edit",
				text: "edited",
				isError: false,
				details: { diff: "@@ -1,2 +1,1 @@\n-const dead = true;\n export const ok = true;" },
			}),
		];
		const cp: TurnCheckpoint = {
			turnId: "t1",
			sessionId: "s1",
			userItemId: "u1",
			prompt: "update files",
			before: "def5678",
			after: "abc1234",
			headBefore: null,
			headAfter: null,
			commits: [],
			endedAt: "2026-11-13T08:00:00Z",
			restorable: true,
			undone: true,
			files: [
				{ status: "A", path: "src/newFile.ts" },
				{ status: "M", path: "src/oldFile.ts" },
				{ status: "D", path: "src/removed.ts" },
			],
		};

		const summary = collectTurnDiffSummary({ steps, turnCheckpoint: cp, cwd: "/repo" });
		expect(summary.files.map((f) => `${f.status}:${f.path}`)).toEqual([
			"A:src/newFile.ts",
			"M:src/oldFile.ts",
			"D:src/removed.ts",
		]);
		expect(summary.totalAdds).toBe(2);
		expect(summary.totalDels).toBe(1);
		expect(summary.undone).toBe(true);

		const { container } = render(
			<TurnDiffCard
				sessionId="s1"
				steps={steps}
				turnCheckpoint={cp}
				sessionCwd="/repo"
				isLatestTurn
			/>,
		);
		expect(container.textContent).toContain("3 个文件已更改");
		expect(container.textContent).toContain("已撤回");

		// Open card
		fireEvent.click(screen.getByRole("button", { name: /3 个文件已更改/ }));
		const expandAllBtn = screen.getByRole("button", { name: "展开全部" });
		fireEvent.click(expandAllBtn);

		expect(container.textContent).toContain("export const b = 2;");
		expect(container.textContent).toContain("const dead = true;");
		expect(screen.getByRole("button", { name: "收起全部" })).toBeTruthy();
	});
});
