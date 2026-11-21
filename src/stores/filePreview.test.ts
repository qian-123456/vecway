// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "../lib/ipc";

const h = vi.hoisted(() => ({
	validatePath: vi.fn(async (_path: string) => ({ exists: false, isDir: false, size: 0 })),
	listWorkspaceFiles: vi.fn(async (_root: string) => [] as string[]),
}));

vi.mock("../lib/ipc", async (original) => ({
	...(await original<typeof IpcModule>()),
	validatePath: h.validatePath,
	listWorkspaceFiles: h.listWorkspaceFiles,
}));

import { useUi } from "./ui";
import { useExplorer } from "./explorer";
import { openFileLink, useFilePreview } from "./filePreview";
import { useToasts } from "../lib/toast";
import { tNow } from "./language";
describe("useFilePreview", () => {
	beforeEach(() => {
		localStorage.clear();
		useFilePreview.setState({ tabs: [], activePath: null });
		useUi.setState({ rightTab: null, openRightTabs: [], rightOpen: true });
	});

	it("opens a file as a preview tab and reveals the right panel", () => {
		useFilePreview.getState().openFile("/a/AGENTS.md", { cwd: "/a" });
		const s = useFilePreview.getState();
		expect(s.tabs).toEqual([{ path: "/a/AGENTS.md", cwd: "/a", mode: "preview" }]);
		expect(s.activePath).toBe("/a/AGENTS.md");
		expect(useUi.getState().rightTab).toBe("files");
		expect(useUi.getState().openRightTabs).toContain("files");
		expect(useUi.getState().rightOpen).toBe(true);
	});

	it("reuses an open tab instead of duplicating it", () => {
		const store = useFilePreview.getState();
		store.openFile("/a/x.ts");
		store.openFile("/a/y.ts");
		store.openFile("/a/x.ts", { mode: "edit" });
		const s = useFilePreview.getState();
		expect(s.tabs.map((t) => t.path)).toEqual(["/a/x.ts", "/a/y.ts"]);
		expect(s.tabs[0].mode).toBe("edit");
		expect(s.activePath).toBe("/a/x.ts");
	});

	it("activates the neighbour after closing the active tab", () => {
		const store = useFilePreview.getState();
		store.openFile("/a/x.ts");
		store.openFile("/a/y.ts");
		store.openFile("/a/z.ts");
		store.setActive("/a/y.ts");
		store.closeFile("/a/y.ts");
		expect(useFilePreview.getState().tabs.map((t) => t.path)).toEqual(["/a/x.ts", "/a/z.ts"]);
		expect(useFilePreview.getState().activePath).toBe("/a/z.ts");
	});

	it("closes the right-panel tab group with the last file", () => {
		const store = useFilePreview.getState();
		store.openFile("/a/x.ts");
		store.closeFile("/a/x.ts");
		expect(useFilePreview.getState().tabs).toEqual([]);
		expect(useFilePreview.getState().activePath).toBeNull();
		expect(useUi.getState().openRightTabs).not.toContain("files");
	});

	it("normalizes paths so one file never opens two tabs", () => {
		const store = useFilePreview.getState();
		store.openFile("/a//x.ts");
		store.openFile("/a/./x.ts");
		store.openFile("/a/x.ts/");
		const s = useFilePreview.getState();
		expect(s.tabs.map((t) => t.path)).toEqual(["/a/x.ts"]);
		expect(s.activePath).toBe("/a/x.ts");
	});
});

describe("openFileLink directory routing and security guard", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
		useFilePreview.setState({ tabs: [], activePath: null });
		useExplorer.setState({
			workspaceId: null,
			customRootPath: null,
			pendingRevealPath: null,
			revealNonce: 0,
		});
		useUi.setState({ rightTab: null, openRightTabs: [], rightOpen: false });
		useToasts.setState({ items: [] });
	});

	it("routes workspace-relative and home directory links to File Explorer", async () => {
		const dirs: Record<string, true> = {
			"/project/.cache": true,
			"/project/docs/statecharts": true,
			"/Users/me/.omp/agent/managed-skills": true,
		};
		h.validatePath.mockImplementation(async (p: string) => ({
			exists: Boolean(dirs[p]),
			isDir: Boolean(dirs[p]),
			size: 0,
		}));

		await openFileLink(".cache/", { cwd: "/project", home: "/Users/me" });
		expect(useExplorer.getState().pendingRevealPath).toBe("/project/.cache");
		expect(useExplorer.getState().revealNonce).toBe(1);
		expect(useUi.getState().rightTab).toBe("explorer");
		expect(useUi.getState().rightOpen).toBe(true);
		expect(useFilePreview.getState().tabs).toEqual([]);

		await openFileLink("docs/statecharts/", { cwd: "/project", home: "/Users/me" });
		expect(useExplorer.getState().pendingRevealPath).toBe("/project/docs/statecharts");
		expect(useExplorer.getState().revealNonce).toBe(2);

		await openFileLink("~/.omp/agent/managed-skills/", { cwd: "/project", home: "/Users/me" });
		expect(useExplorer.getState().pendingRevealPath).toBe("/Users/me/.omp/agent/managed-skills");
		expect(useExplorer.getState().revealNonce).toBe(3);
		expect(useToasts.getState().items).toEqual([]);
	});

	it("still blocks binary and non-previewable files (.app, .command, .bin)", async () => {
		h.validatePath.mockImplementation(async (p: string) => ({
			exists: true,
			isDir: p.endsWith(".app"),
			size: p.endsWith(".app") ? 0 : 100,
		}));

		for (const blocked of [
			"/Applications/Evil.app",
			"/Users/me/run.command",
			"/project/tool.bin",
		]) {
			await openFileLink(blocked, { cwd: "/project", home: "/Users/me" });
		}

		expect(useFilePreview.getState().tabs).toEqual([]);
		expect(useExplorer.getState().pendingRevealPath).toBeNull();
		expect(useUi.getState().rightTab).toBeNull();
		const toasts = useToasts.getState().items;
		expect(toasts).toHaveLength(3);
		expect(toasts[0]).toMatchObject({
			kind: "error",
			text: tNow("shell.blockedPreviewNonTextOrImage", { name: "Evil.app" }),
		});
		expect(toasts[1]).toMatchObject({
			kind: "error",
			text: tNow("shell.blockedPreviewNonTextOrImage", { name: "run.command" }),
		});
		expect(toasts[2]).toMatchObject({
			kind: "error",
			text: tNow("shell.blockedPreviewNonTextOrImage", { name: "tool.bin" }),
		});
	});
});
