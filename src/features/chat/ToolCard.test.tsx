// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (s: string) => s }));

import { ToolCard, toolActivityLabel } from "./ToolCard";
import { tNow } from "../../stores/language";

afterEach(cleanup);

describe("wait tool", () => {
	it("reads as 等待 + its description, not a generic tool call", () => {
		expect(toolActivityLabel("wait", {}, "Wait for scout result", "running")).toEqual({
			verb: "正在等待",
			object: "Wait for scout result",
			objectIsCode: false,
		});
		expect(toolActivityLabel("wait", {}, null, "done").verb).toBe("已等待");
	});

	it("has no expandable args box for empty or wait args", () => {
		render(<ToolCard sessionId="s" name="wait" args={{}} intent="x" status="running" />);
		expect(screen.queryByRole("button")).toBeNull();
		cleanup();
		render(<ToolCard sessionId="s" name="wait" args={{ i: "x" }} intent="x" status="done" />);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("an unrelated tool with empty args also shows no empty box", () => {
		render(<ToolCard sessionId="s" name="mystery" args={{}} status="done" />);
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("ask tool results", () => {
	it("renders current form answers, empty fields and option notes as compact rows", () => {
		render(<ToolCard
			sessionId="s"
			name="ask"
			status="done"
			args={{ html: '<form><input name="db"></form>' }}
			details={{
				answers: [
					{ name: "db", question: "Database?", answer: "SQLite" },
					{ name: "extra", question: "Anything else?", answer: "" },
					{ name: "language", question: "Language?", answer: "Rust" },
				],
				notes: [
					{ name: "language", question: "Language?", option: "Rust", value: "rs", text: "Backend only" },
				],
			}}
		/>);
		expect(screen.getByText("Database? → SQLite")).toBeTruthy();
		expect(screen.getByText(`Anything else? → ${tNow("tools.ask.unanswered")}`)).toBeTruthy();
		expect(screen.getByText("Language? → Rust — Rust: Backend only")).toBeTruthy();
		expect(screen.queryByText(/<form>/)).toBeNull();
	});

	it("keeps historical question-shaped transcript results readable", () => {
		render(<ToolCard
			sessionId="s"
			name="ask"
			status="done"
			details={{ results: [{ question: "Legacy question?", selectedOptions: ["A"], customInput: "More" }] }}
		/>);
		expect(screen.getByText("Legacy question? → A、More")).toBeTruthy();
	});
});
