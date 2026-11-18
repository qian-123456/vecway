// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REQUEST_STAT_FIELDS, useDisplayPrefs } from "../../stores/displayPrefs";
import { tNow, useLanguageStore } from "../../stores/language";
import { RequestStatsLine } from "./RequestStatsLine";
import type { RequestStat } from "./requestStats";

// Exercise the real FloatingLayer, including its document-level dismissal.
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;

const initialDisplayPrefs = useDisplayPrefs.getState();
const initialLanguage = useLanguageStore.getState();
const success: RequestStat = {
	startedAt: new Date(2026, 9, 17, 12, 47, 23).getTime(),
	completedAt: new Date(2026, 9, 17, 12, 47, 30).getTime(),
	durationMs: 7000,
	ttftMs: 2000,
	usage: { input: 10, output: 100, cacheRead: 20, cacheWrite: 0, totalTokens: 130, cost: 0.01 },
	error: null,
};
const failure: RequestStat = { ...success, error: "Service temporarily unavailable" };

beforeEach(() => {
	vi.useFakeTimers();
	useDisplayPrefs.setState({ requestStats: true, requestStatFields: { ...DEFAULT_REQUEST_STAT_FIELDS } });
	useLanguageStore.setState({ locale: "zh-CN" });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	useDisplayPrefs.setState(initialDisplayPrefs);
	useLanguageStore.setState(initialLanguage);
});

function click(target: Element) {
	// Include mousedown: ignoring the trigger must prevent dismiss-then-reopen.
	fireEvent.mouseDown(target);
	fireEvent.mouseUp(target);
	fireEvent.click(target);
}

function trigger() {
	return screen.getByRole("button", { name: tNow("chatView.stats.ariaViewStats") });
}

function cardTitle(stat = success) {
	return tNow(stat.error ? "chatView.stats.modelRequestFailed" : "chatView.stats.modelRequest");
}

function advancePastHoverDelays() {
	act(() => vi.advanceTimersByTime(2000));
}

describe("RequestStatsLine click-only explanation", () => {
	it.each([success, failure])("does not open on hover for a request with error=$error", (stat) => {
		render(<RequestStatsLine stat={stat} />);
		fireEvent.mouseEnter(trigger());
		advancePastHoverDelays();
		expect(screen.queryByText(cardTitle(stat))).toBeNull();
		expect(trigger().getAttribute("aria-expanded")).toBe("false");
		fireEvent.mouseLeave(trigger());
		advancePastHoverDelays();
		expect(screen.queryByText(cardTitle(stat))).toBeNull();
	});

	it("opens on click, survives pointer leave and card interaction, then closes on the second click", () => {
		render(<RequestStatsLine stat={success} />);
		const line = trigger();
		click(line);
		expect(line.getAttribute("aria-expanded")).toBe("true");
		const title = screen.getByText(cardTitle());
		expect(screen.getByText(tNow("chatView.stats.fieldOutputDesc"))).toBeTruthy();
		fireEvent.mouseLeave(line);
		advancePastHoverDelays();
		expect(screen.getByText(cardTitle())).toBeTruthy();
		fireEvent.mouseEnter(title);
		click(title);
		fireEvent.mouseLeave(title);
		advancePastHoverDelays();
		expect(screen.getByText(cardTitle())).toBeTruthy();
		click(line);
		expect(screen.queryByText(cardTitle())).toBeNull();
		expect(line.getAttribute("aria-expanded")).toBe("false");
		advancePastHoverDelays();
		expect(screen.queryByText(cardTitle())).toBeNull();
	});

	it.each(["outside click", "Escape"])("dismisses on %s and can be opened again", (dismissal) => {
		render(<RequestStatsLine stat={success} />);
		click(trigger());
		expect(screen.getByText(cardTitle())).toBeTruthy();
		if (dismissal === "outside click") click(document.body);
		else fireEvent.keyDown(document.body, { key: "Escape" });
		expect(screen.queryByText(cardTitle())).toBeNull();
		expect(trigger().getAttribute("aria-expanded")).toBe("false");
		click(trigger());
		expect(screen.getByText(cardTitle())).toBeTruthy();
	});

	it.each(["Enter", " "])("supports keyboard toggle with %j and Escape", (key) => {
		render(<RequestStatsLine stat={success} />);
		const line = trigger();
		line.focus();
		expect(document.activeElement).toBe(line);
		fireEvent.keyDown(line, { key });
		expect(screen.getByText(cardTitle())).toBeTruthy();
		expect(line.getAttribute("aria-expanded")).toBe("true");
		fireEvent.keyDown(line, { key });
		expect(screen.queryByText(cardTitle())).toBeNull();
		expect(line.getAttribute("aria-expanded")).toBe("false");
		fireEvent.keyDown(line, { key });
		fireEvent.keyDown(line, { key: "Escape" });
		expect(screen.queryByText(cardTitle())).toBeNull();
		expect(line.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(line);
	});

	it("preserves the failed-request explanation and complete error", () => {
		render(<RequestStatsLine stat={failure} />);
		click(trigger());
		expect(screen.getByText(cardTitle(failure))).toBeTruthy();
		expect(screen.getByText(tNow("chatView.stats.requestFailedExplanation"))).toBeTruthy();
		expect(screen.getAllByText(failure.error!)).toHaveLength(2);
		expect(screen.getByText(tNow("chatView.stats.waitDuration"))).toBeTruthy();
		expect(screen.queryByText(tNow("chatView.stats.fieldOutputDesc"))).toBeNull();
	});
});
