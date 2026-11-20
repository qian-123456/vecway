// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentInfo } from "../../../stores/live";
import type { AgentRow } from "./merge";
import { SubagentHoverCard } from "./SubagentHoverCard";

afterEach(cleanup);

if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = class ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}

function makeAnchor(): HTMLDivElement {
	const el = document.createElement("div");
	document.body.appendChild(el);
	return el;
}

describe("SubagentHoverCard", () => {
	it("shows single start-end completion range and duration for single-segment runs", () => {
		const anchor = makeAnchor();
		const s = new Date(2026, 10, 19, 20, 16, 12).toISOString();
		const e = new Date(2026, 10, 19, 20, 20, 27).toISOString(); // 4m15s
		const info: SubagentInfo = { status: "completed", label: "Plan" };
		const row: AgentRow = {
			id: "Plan",
			index: 0,
			status: "completed",
			startedAt: s,
			endedAt: e,
			runSegments: [{ startedAt: s, endedAt: e }],
			durationMs: 255_000,
		};

		render(
			<SubagentHoverCard
				id="Plan"
				info={info}
				row={row}
				state="done"
				elapsed={255_000}
				parentName={undefined}
				anchor={anchor}
			/>,
		);

		expect(screen.getByText("用时")).toBeTruthy();
		expect(screen.getByText("4分15秒")).toBeTruthy();
		expect(screen.getByText("完成")).toBeTruthy();
		expect(screen.getByText("20:16:12 - 20:20:27")).toBeTruthy();
		expect(screen.queryByText("时段")).toBeNull();
	});

	it("shows stacked run segments and active total duration for multi-segment runs", () => {
		const anchor = makeAnchor();
		const s1 = new Date(2026, 10, 19, 20, 16, 12).toISOString();
		const e1 = new Date(2026, 10, 19, 20, 31, 32).toISOString(); // 15m20s
		const s2 = new Date(2026, 10, 19, 20, 34, 22).toISOString();
		const e2 = new Date(2026, 10, 19, 20, 38, 37).toISOString(); // 4m15s
		const info: SubagentInfo = { status: "completed", label: "PlanStatechart" };
		const row: AgentRow = {
			id: "PlanStatechart",
			index: 0,
			status: "completed",
			startedAt: s1,
			endedAt: e2,
			runSegments: [
				{ startedAt: s1, endedAt: e1 },
				{ startedAt: s2, endedAt: e2 },
			],
			durationMs: 1_175_000,
		};

		render(
			<SubagentHoverCard
				id="PlanStatechart"
				info={info}
				row={row}
				state="done"
				elapsed={1_175_000}
				parentName={undefined}
				anchor={anchor}
			/>,
		);

		expect(screen.getByText("用时")).toBeTruthy();
		expect(screen.getByText("19分35秒")).toBeTruthy();
		expect(screen.getByText("时段")).toBeTruthy();
		expect(screen.getByText("20:16:12 - 20:31:32 · 15分20秒")).toBeTruthy();
		expect(screen.getByText("20:34:22 - 20:38:37 · 4分15秒")).toBeTruthy();
		expect(screen.queryByText("完成")).toBeNull();
	});
});
