// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../../core/api";
import * as uiModule from "../../ui";
import { ScheduleRunsPage } from "./ScheduleRunsPage";

vi.mock("../../core/nav", () => ({ nav: { back: vi.fn(), push: vi.fn(), pushLayer: () => () => {} }, paths: { chat: (id: string) => `/s/${id}` } }));
vi.mock("../../ui", async (orig) => ({ ...await orig<typeof uiModule>(), toast: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

const route = { name: "scheduleRuns" as const, path: "/schedules/a", params: { id: "schedule / 1" }, query: {} };
const base = "/left/schedules/schedule%20%2F%201";
const run = { id: "run / 1", scheduleId: route.params.id, sessionId: "session-1", status: "running", startedAt: "2026-01-01T00:00:00Z", finishedAt: null, summary: "等待原会话" };

describe("waiting schedule runs", () => {
	it("resumes the identified run, disables actions during the request, and refreshes all records", async () => {
		let waiting = true;
		// The mobile ES2021 target does not expose Promise.withResolvers.
		let resolve!: () => void;
		const promise = new Promise<void>((done) => { resolve = done; });
		const request = vi.spyOn(apiModule, "api").mockImplementation(async (method, path) => {
			if (method === "POST") {
				await promise;
				waiting = false;
				return {};
			}
			if (path === `${base}/awaiting`) return waiting ? [run] : [];
			if (path === `${base}/runs?limit=50`) return [run];
			return [{ id: route.params.id, name: "任务" }];
		});
		render(<ScheduleRunsPage route={route} />);
		fireEvent.click(await screen.findByRole("button", { name: "继续运行" }));
		expect(request).toHaveBeenCalledWith("POST", `${base}/runs/run%20%2F%201/resume-awaiting`);
		expect((screen.getByRole("button", { name: /解除等待/ }) as HTMLButtonElement).disabled).toBe(true);
		resolve();
		await waitFor(() => expect(screen.queryByRole("button", { name: "继续运行" })).toBeNull());
		expect(request.mock.calls.filter(([method, path]) => method === "GET" && path === `${base}/awaiting`)).toHaveLength(2);
		expect(request.mock.calls.filter(([method, path]) => method === "GET" && path === `${base}/runs?limit=50`)).toHaveLength(2);
		expect(request.mock.calls.filter(([method, path]) => method === "GET" && path === "/left/schedules")).toHaveLength(2);
	});

	it("reports a rejected recovery and refreshes without releasing the waiting run", async () => {
		const request = vi.spyOn(apiModule, "api").mockImplementation(async (method, path) => {
			if (method === "POST") throw new Error("原会话仍在线");
			if (path === `${base}/awaiting` || path === `${base}/runs?limit=50`) return [run];
			return [{ id: route.params.id, name: "任务" }];
		});
		render(<ScheduleRunsPage route={route} />);
		fireEvent.click(await screen.findByRole("button", { name: "继续运行" }));
		await waitFor(() => expect(uiModule.toast).toHaveBeenCalledWith("继续运行失败：原会话仍在线", { kind: "error" }));
		await waitFor(() => expect(request.mock.calls.filter(([method, path]) => method === "GET" && path === `${base}/awaiting`)).toHaveLength(2));
		await waitFor(() => expect((screen.getByRole("button", { name: "继续运行" }) as HTMLButtonElement).disabled).toBe(false));
		expect(request.mock.calls.filter(([method]) => method === "POST")).toEqual([["POST", `${base}/runs/run%20%2F%201/resume-awaiting`]]);
	});
});
