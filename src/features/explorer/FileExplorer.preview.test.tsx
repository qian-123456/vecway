// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "../../lib/ipc";

const h = vi.hoisted(() => ({
	fsReadDir: vi.fn(async (_path: string) => [
		{ name: "chart.png", path: "/project/chart.png", isDir: false },
		{ name: "chart.mmd", path: "/project/chart.mmd", isDir: false },
		{ name: "notes.md", path: "/project/notes.md", isDir: false },
		{ name: "index.ts", path: "/project/index.ts", isDir: false },
		{ name: "archive.zip", path: "/project/archive.zip", isDir: false },
	]),
	listWorkspaceFiles: vi.fn(async () => ["src/app.ts", "archive.zip"]),
	importImageFile: vi.fn(async (_path: string) => "/allowed/chart.png"),
	readTextFile: vi.fn(async (path: string) =>
		path.endsWith(".mmd") ? "graph TD\nA-->B" : "# Notes\nhello",
	),
}));
vi.mock("../../lib/ipc", async (original) => ({
	...(await original<typeof IpcModule>()),
	fsReadDir: h.fsReadDir,
	listWorkspaceFiles: h.listWorkspaceFiles,
	importImageFile: h.importImageFile,
	readTextFile: h.readTextFile,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/me" }));
vi.mock("../chat/mermaidRender", () => ({
	currentMermaidMode: () => "dark",
	renderMermaidSvg: vi.fn(async () => '<svg viewBox="0 0 100 40"></svg>'),
	svgViewBoxSize: () => ({ width: 100, height: 40 }),
}));

import { FileExplorer } from "./FileExplorer";
import { FilePreviewPanel } from "../files/FilePreviewPanel";
import { useExplorer } from "../../stores/explorer";
import { useFilePreview } from "../../stores/filePreview";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { useToasts } from "../../lib/toast";
import { tNow } from "../../stores/language";

describe("file tree preview routing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		h.fsReadDir.mockImplementation(async (_path: string) => [
			{ name: "chart.png", path: "/project/chart.png", isDir: false },
			{ name: "chart.mmd", path: "/project/chart.mmd", isDir: false },
			{ name: "notes.md", path: "/project/notes.md", isDir: false },
			{ name: "index.ts", path: "/project/index.ts", isDir: false },
			{ name: "archive.zip", path: "/project/archive.zip", isDir: false },
		]);
		useSessions.setState({ workspaces: [{ id: "project", name: "Project", path: "/project", kind: "project", mode: "code" }] } as never);
		useExplorer.setState({
			workspaceId: "project",
			customRootPath: null,
			pendingRevealPath: null,
			revealNonce: 0,
		});
		useFilePreview.setState({ tabs: [], activePath: null });
		useUi.setState({ centerView: "session", selectedSessionId: null, docPath: null, rightTab: null });
		useToasts.setState({ items: [] });
	});
	afterEach(cleanup);

	it("opens a project PNG through the actual file tree and renders the scoped copy", async () => {
		render(<><FileExplorer /><FilePreviewPanel /></>);
		fireEvent.click(await screen.findByText("chart.png"));
		await waitFor(() => expect(screen.getByRole("img", { name: "chart.png" }).getAttribute("src")).toBe("/allowed/chart.png"));
		expect(h.importImageFile).toHaveBeenCalledWith("/project/chart.png");
		expect(h.readTextFile).not.toHaveBeenCalled();
		expect(useUi.getState().centerView).toBe("session");
	});

	it("opens Mermaid, markdown, and code files in right-panel preview tabs without calling openDoc", async () => {
		const openDocSpy = vi.spyOn(useUi.getState(), "openDoc");
		render(<><FileExplorer /><FilePreviewPanel /></>);

		fireEvent.click(await screen.findByText("chart.mmd"));
		await waitFor(() => expect(screen.getByText("图表")).toBeTruthy());
		expect(h.readTextFile).toHaveBeenCalledWith("/project/chart.mmd");

		fireEvent.click(screen.getByText("notes.md"));
		await waitFor(() => expect(useFilePreview.getState().activePath).toBe("/project/notes.md"));

		fireEvent.click(screen.getByText("index.ts"));
		await waitFor(() => expect(useFilePreview.getState().activePath).toBe("/project/index.ts"));

		expect(useFilePreview.getState().tabs.map((tab) => tab.path)).toEqual([
			"/project/chart.mmd",
			"/project/notes.md",
			"/project/index.ts",
		]);
		expect(openDocSpy).not.toHaveBeenCalled();
		expect(useUi.getState().docPath).toBeNull();
		expect(useUi.getState().centerView).toBe("session");
		expect(useUi.getState().rightTab).toBe("files");
		openDocSpy.mockRestore();
	});

	it("opens previewable search results in right-panel tabs and blocks binary files with an error toast", async () => {
		const openDocSpy = vi.spyOn(useUi.getState(), "openDoc");
		render(<FileExplorer />);

		fireEvent.click(await screen.findByText("archive.zip"));
		expect(openDocSpy).not.toHaveBeenCalled();
		expect(useFilePreview.getState().tabs).toEqual([]);
		const toasts = useToasts.getState().items;
		expect(toasts[toasts.length - 1]).toMatchObject({
			kind: "error",
			text: tNow("shell.blockedPreviewNonTextOrImage", { name: "archive.zip" }),
		});

		fireEvent.click(screen.getByTitle(tNow("explorer.searchFilesTip")));
		const input = screen.getByPlaceholderText(tNow("explorer.searchFilterPlaceholder"));
		fireEvent.change(input, { target: { value: "app.ts" } });

		fireEvent.click(await screen.findByText("app.ts", {}, { timeout: 2000 }));
		expect(useFilePreview.getState().activePath).toBe("/project/src/app.ts");
		expect(openDocSpy).not.toHaveBeenCalled();
		expect(useUi.getState().centerView).toBe("session");
		openDocSpy.mockRestore();
	});

	it("expands and reveals a directory inside the current workspace", async () => {
		const tree: Record<string, Array<{ name: string; path: string; isDir: boolean }>> = {
			"/project": [
				{ name: ".cache", path: "/project/.cache", isDir: true },
				{ name: "docs", path: "/project/docs", isDir: true },
			],
			"/project/docs": [
				{ name: "statecharts", path: "/project/docs/statecharts", isDir: true },
			],
			"/project/docs/statecharts": [
				{ name: "flow.mmd", path: "/project/docs/statecharts/flow.mmd", isDir: false },
			],
		};
		h.fsReadDir.mockImplementation(async (p: string) => tree[p] ?? []);

		const { container } = render(<FileExplorer />);
		await screen.findByText("docs");

		act(() => {
			useExplorer.getState().openDirectory("/project/docs/statecharts/");
		});

		await screen.findByText("flow.mmd");
		const targetNode = container.querySelector<HTMLElement>(
			'[data-tree-path="/project/docs/statecharts"]',
		);
		expect(targetNode).not.toBeNull();
		expect(targetNode?.getAttribute("aria-expanded")).toBe("true");
		expect(targetNode?.getAttribute("aria-selected")).toBe("true");
		expect(useExplorer.getState().customRootPath).toBeNull();
	});

	it("temporarily roots at an external directory and returns to workspace on clear", async () => {
		const externalDir = "/Users/me/.omp/agent/managed-skills";
		const tree: Record<string, Array<{ name: string; path: string; isDir: boolean }>> = {
			"/project": [
				{ name: "notes.md", path: "/project/notes.md", isDir: false },
			],
			[externalDir]: [
				{ name: "skill-a", path: `${externalDir}/skill-a`, isDir: true },
				{ name: "README.md", path: `${externalDir}/README.md`, isDir: false },
			],
		};
		h.fsReadDir.mockImplementation(async (p: string) => tree[p] ?? []);

		render(<FileExplorer />);
		await screen.findByText("notes.md");

		act(() => {
			useExplorer.getState().openDirectory(`${externalDir}/`);
		});

		await screen.findByText("skill-a");
		expect(screen.getByText("README.md")).toBeTruthy();
		expect(useExplorer.getState().customRootPath).toBe(externalDir);
		expect(screen.getByText("~/.omp/agent/managed-skills")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: tNow("explorer.backToWorkspace") }));

		await waitFor(() => expect(useExplorer.getState().customRootPath).toBeNull());
		await screen.findByText("notes.md");
	});
});
