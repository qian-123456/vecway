// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VisualizeBlock } from "./VisualizeBlock";

afterEach(cleanup);

describe("VisualizeBlock streaming progress", () => {
	it("shows generated line count while streaming", () => {
		render(<VisualizeBlock html={"<div>\n<p>hi</p>\n</div>"} mode="standard" streaming />);
		expect(screen.getByText(/已生成 3 行|3 lines/)).toBeTruthy();
	});
});
