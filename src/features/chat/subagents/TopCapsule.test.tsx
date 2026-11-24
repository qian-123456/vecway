// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentInfo } from "./types";

let mockSubagents: Record<string, SubagentInfo> = {};

vi.mock("./useSessionSubagents", () => ({
	useSessionSubagents: () => ({ parentFile: null, subagents: mockSubagents, rows: {} }),
}));

import { useSettings } from "../../settings/store";
import { useUi } from "../../../stores/ui";
import { TopCapsule } from "./TopCapsule";

afterEach(() => {
	cleanup();
	mockSubagents = {};
});

describe("TopCapsule hook-order stability", () => {
	it("transitions 0 -> 1+ -> 0 subagents without throwing a React hook-order error", () => {
		useUi.setState({ selectedSessionId: "s1" });
		useSettings.setState({ settings: { capsuleVisible: true } as never, error: null });

		mockSubagents = {};
		const { rerender, container } = render(<TopCapsule />);
		expect(container.firstChild).toBeNull();

		mockSubagents = {
			A: { status: "running", agent: "task", description: "", index: 0 } as unknown as SubagentInfo,
		};
		expect(() => rerender(<TopCapsule />)).not.toThrow();
		expect(container.firstChild).not.toBeNull();

		mockSubagents = {};
		expect(() => rerender(<TopCapsule />)).not.toThrow();
		expect(container.firstChild).toBeNull();
	});
});
