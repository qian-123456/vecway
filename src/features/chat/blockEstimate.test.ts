import { describe, expect, it } from "vitest";
import { estimateBlockHeight, estimateTextHeight } from "./blockEstimate";
import type { DisplayBlock, TurnBlock } from "./turnGrouping";
import type { TranscriptItem } from "../../lib/contracts";

const item = (id: string, text: string | null): TranscriptItem => ({
	id,
	parentId: null,
	ts: "2026-01-01T00:00:00Z",
	kind: "assistant",
	text,
	thinking: null,
	toolCalls: [],
	toolResult: null,
	usage: null,
	model: null,
	stopReason: null,
	hidden: false,
});

const turn = (answer: string | null, steps = 0): TurnBlock => ({
	type: "turn",
	id: "t",
	userItem: item("u", "hi"),
	intermediateSteps: Array.from({ length: steps }, (_, i) => ({
		id: `s${i}`,
		kind: "steer" as const,
		item: item(`s${i}`, "x"),
		text: "x",
	})),
	answerItem: answer === null ? undefined : item("a", answer),
	allItemIds: ["u", "a"],
	stepCount: steps,
});

describe("block height estimates", () => {
	it("a long answer is estimated taller than a short one", () => {
		const short = estimateBlockHeight(turn("ok"));
		const long = estimateBlockHeight(turn("段落内容。".repeat(400)));
		expect(long).toBeGreaterThan(short * 5);
	});

	it("fenced code counts per source line, not as one wrapped paragraph", () => {
		const code = "```\n" + "const a = 1;\n".repeat(50) + "```";
		const prose = "const a = 1; ".repeat(50);
		expect(estimateTextHeight(code)).toBeGreaterThan(estimateTextHeight(prose));
	});

	it("tool steps add the collapsed-disclosure row", () => {
		expect(estimateBlockHeight(turn("ok", 3))).toBeGreaterThan(
			estimateBlockHeight(turn("ok", 0)),
		);
	});

	it("never collapses to zero for empty or missing blocks", () => {
		expect(estimateBlockHeight(undefined)).toBeGreaterThan(0);
		expect(estimateBlockHeight(turn(null))).toBeGreaterThan(0);
	});

	it("caps a pasted long prompt at the clamped user-bubble height", () => {
		const long = { ...turn("ok"), userItem: item("u", "line of prompt\n".repeat(300)) } as DisplayBlock;
		const short = { ...turn("ok"), userItem: item("u", "line\n".repeat(4)) } as DisplayBlock;
		expect(estimateBlockHeight(long) - estimateBlockHeight(short)).toBeLessThan(60);
	});

	it("estimates full height for multi-paragraph interim prose while capping brief tool transitions", () => {
		const toolStep = {
			id: "tool-1",
			kind: "tool" as const,
			item: item("tool-item-1", null),
			call: { id: "c1", name: "read", args: { path: "src/a.ts" }, intent: null },
		};
		const multiParagraph = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 段详细说明内容，用于验证多段过渡回复不会被截断估值。`).join("\n\n");
		const fullProseTurn: DisplayBlock = {
			...turn("final"),
			intermediateSteps: [
				{ id: "p1", kind: "text", item: item("p1", multiParagraph), text: multiParagraph },
				toolStep,
			],
			stepCount: 2,
		};
		const briefText = "先读取配置文件。";
		const briefProseTurn: DisplayBlock = {
			...turn("final"),
			intermediateSteps: [
				{ id: "p1", kind: "text", item: item("p1", briefText), text: briefText },
				toolStep,
			],
			stepCount: 2,
		};
		expect(estimateBlockHeight(fullProseTurn) - estimateBlockHeight(briefProseTurn)).toBeGreaterThan(360);
	});

	it("reserves TurnDiffCard row height when a turn edited files", () => {
		const readTurn: DisplayBlock = {
			...turn("done"),
			intermediateSteps: [
				{
					id: "t-read",
					kind: "tool",
					item: item("t-read", null),
					call: { id: "c1", name: "read", args: { path: "src/a.ts" }, intent: null },
				},
			],
			stepCount: 1,
		};
		const editTurn: DisplayBlock = {
			...turn("done"),
			intermediateSteps: [
				{
					id: "t-edit",
					kind: "tool",
					item: item("t-edit", null),
					call: { id: "c1", name: "edit", args: { path: "src/a.ts" }, intent: null },
				},
			],
			stepCount: 1,
		};
		expect(estimateBlockHeight(editTurn)).toBeGreaterThan(estimateBlockHeight(readTurn));
	});
});
