// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { confirmDialog } from "./dialogs";

afterEach(cleanup);

describe("confirmDialog danger Enter safety", () => {
	it("blocks non-button Enter when danger=true and requires explicit button activation", async () => {
		const promise = confirmDialog("Delete everything?", {
			title: "Danger",
			danger: true,
			okLabel: "Delete",
			cancelLabel: "Cancel",
		});

		const dialog = await screen.findByRole("dialog");
		// Focus the dialog body (non-button) and press Enter — must NOT confirm!
		fireEvent.keyDown(dialog, { key: "Enter" });

		// Dialog must still be mounted
		expect(screen.queryByRole("dialog")).not.toBeNull();

		// Clicking Cancel resolves false
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await expect(promise).resolves.toBe(false);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("allows non-button Enter when danger=false", async () => {
		const promise = confirmDialog("Proceed?", {
			title: "Confirm",
			danger: false,
			okLabel: "OK",
			cancelLabel: "Cancel",
		});

		const dialog = await screen.findByRole("dialog");
		await act(async () => {
			fireEvent.keyDown(dialog, { key: "Enter" });
		});
		await expect(promise).resolves.toBe(true);
	});
});
