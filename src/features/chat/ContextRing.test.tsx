// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "../../lib/ipc";
import { useLanguageStore } from "../../stores/language";
import { useLive } from "../../stores/live";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { ContextRing } from "./ContextRing";

vi.mock("../../lib/ipc", async (importOriginal) => {
	const orig = await importOriginal<typeof IpcModule>();
	return {
		...orig,
		sessionPromptComposition: vi.fn(async () => ({
			categories: [],
			totalTokens: 0,
		})),
	};
});

beforeAll(() => {
	class RO {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", RO);
});

const initialLanguage = useLanguageStore.getState();

beforeEach(() => {
	useLanguageStore.setState({ locale: "zh-CN" });
	useLive.setState({ sessions: {} });
	useSessions.setState({ sessions: {} } as never);
	useUi.setState({ selectedSessionId: null } as never);
});

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
	useLanguageStore.setState(initialLanguage);
});

describe("ContextRing", () => {
	it("shows localized unknown label instead of raw 'undefined' when contextWindow is unknown", () => {
		render(<ContextRing usageObj={{ tokens: 50_000, contextWindow: undefined, percent: undefined }} />);
		fireEvent.click(screen.getByRole("button"));
		expect(document.body.textContent).not.toContain("undefined");
		expect(document.body.textContent).not.toContain("contextWindow");
		expect(screen.getByText(/50k\s*\/\s*未知/)).toBeTruthy();
		expect(screen.getByText("已用")).toBeTruthy();
		expect(screen.getByText("50k")).toBeTruthy();
		expect(screen.getByText("未知")).toBeTruthy();
	});

	it("shows localized unknown label when contextWindow is absent or non-positive", () => {
		render(<ContextRing usageObj={{ tokens: 12_300 }} />);
		fireEvent.click(screen.getByRole("button"));
		expect(document.body.textContent).not.toContain("undefined");
		expect(screen.getByText(/12\.3k\s*\/\s*未知/)).toBeTruthy();
		expect(screen.getByText("未知")).toBeTruthy();
	});

	it("renders token usage and context window when both are known", () => {
		render(<ContextRing usageObj={{ tokens: 50_000, contextWindow: 1_000_000, percent: 5 }} />);
		fireEvent.click(screen.getByRole("button"));

		expect(screen.getAllByText("5%").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText(/50k\s*\/\s*1M/)).toBeTruthy();
		expect(document.body.textContent).not.toContain("undefined");
	});

	it("toggles popover on click", () => {
		render(<ContextRing usageObj={{ tokens: 50_000 }} />);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText("未知")).toBeTruthy();
	});
});
