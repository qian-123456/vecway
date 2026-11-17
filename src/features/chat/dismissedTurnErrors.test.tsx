// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDismissedTurnErrors } from "./dismissedTurnErrors";
import { TurnErrorCard } from "./MessageList";

const STORAGE_KEY = "ompws:dismissed-turn-errors";

describe("dismissedTurnErrors", () => {
	beforeEach(() => {
		localStorage.clear();
		useDismissedTurnErrors.setState({ dismissedBySession: {} });
	});

	afterEach(() => {
		cleanup();
	});

	it("persists dismissed error keys per session in localStorage", () => {
		useDismissedTurnErrors.getState().dismiss("sess-1", "err-1");
		useDismissedTurnErrors.getState().dismiss("sess-1", "err-1");
		useDismissedTurnErrors.getState().dismiss("sess-2", "err-2");

		expect(useDismissedTurnErrors.getState().dismissedBySession).toEqual({
			"sess-1": ["err-1"],
			"sess-2": ["err-2"],
		});

		const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
		expect(persisted).toEqual({
			"sess-1": ["err-1"],
			"sess-2": ["err-2"],
		});
	});

	it("clears dismissed error keys for a deleted session", () => {
		useDismissedTurnErrors.getState().dismiss("sess-1", "err-1");
		useDismissedTurnErrors.getState().dismiss("sess-2", "err-2");

		useDismissedTurnErrors.getState().clearSession("sess-1");

		expect(useDismissedTurnErrors.getState().dismissedBySession).toEqual({
			"sess-2": ["err-2"],
		});
	});
});

describe("TurnErrorCard", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders a dismiss button and invokes onDismiss when clicked", () => {
		const onDismiss = vi.fn();
		render(
			<TurnErrorCard
				reason='404 Model "glm-5.3-flash" is not available'
				modelRef="provider/glm-5.3-flash"
				retrying={false}
				onRetry={vi.fn()}
				onSwitchModel={vi.fn()}
				onDismiss={onDismiss}
			/>,
		);

		const dismissBtn = screen.getByRole("button", { name: /关闭错误提示|Dismiss error/i });
		fireEvent.click(dismissBtn);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("omits the dismiss button when onDismiss is not provided", () => {
		render(
			<TurnErrorCard
				reason="Network error"
				modelRef={null}
				retrying={false}
				onRetry={vi.fn()}
				onSwitchModel={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: /关闭错误提示|Dismiss error/i }),
		).toBeNull();
	});
});
