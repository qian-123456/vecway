// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchInput } from "./SearchInput";

afterEach(cleanup);

function Host({ initial = "", onClear }: { initial?: string; onClear?: () => void }) {
	const [v, setV] = useState(initial);
	return <SearchInput value={v} onChange={setV} placeholder="搜索" onClear={onClear} />;
}

describe("SearchInput", () => {
	it("types, then the clear button empties it and calls onClear", () => {
		const onClear = vi.fn();
		render(<Host onClear={onClear} />);
		const input = screen.getByPlaceholderText("搜索") as HTMLInputElement;
		expect(screen.queryByLabelText("清除搜索")).toBeNull();
		fireEvent.change(input, { target: { value: "abc" } });
		expect(input.value).toBe("abc");
		fireEvent.click(screen.getByLabelText("清除搜索"));
		expect(input.value).toBe("");
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(screen.queryByLabelText("清除搜索")).toBeNull();
	});

	it("Escape clears a non-empty value and claims the key", () => {
		render(<Host initial="abc" />);
		const input = screen.getByPlaceholderText("搜索") as HTMLInputElement;
		const notPrevented = fireEvent.keyDown(input, { key: "Escape" });
		expect(notPrevented).toBe(false);
		expect(input.value).toBe("");
	});

	it("Escape on an empty value is left alone", () => {
		render(<Host />);
		const input = screen.getByPlaceholderText("搜索");
		expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(true);
	});

	it("forwards ref and autoFocus", () => {
		const ref = createRef<HTMLInputElement>();
		render(<SearchInput ref={ref} value="" onChange={() => {}} autoFocus />);
		expect(ref.current).toBeInstanceOf(HTMLInputElement);
		expect(document.activeElement).toBe(ref.current);
	});

	it("shows GitHub-style '/' shortcut hint only when empty and unfocused while keeping placeholder accessible", () => {
		function HintHost() {
			const [v, setV] = useState("");
			return <SearchInput value={v} onChange={setV} placeholder="搜索 Skill…" shortcutHint="/" />;
		}
		const { container } = render(<HintHost />);
		const input = screen.getByPlaceholderText("搜索 Skill…") as HTMLInputElement;
		expect(container.querySelector("kbd")?.textContent).toBe("/");

		fireEvent.focus(input);
		expect(container.querySelector("kbd")).toBeNull();

		fireEvent.blur(input);
		expect(container.querySelector("kbd")?.textContent).toBe("/");

		fireEvent.change(input, { target: { value: "git" } });
		expect(container.querySelector("kbd")).toBeNull();
	});
});
