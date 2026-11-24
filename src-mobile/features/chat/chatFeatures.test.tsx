// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { nav } from "../../core/nav";
import type { PendingEntry } from "../../core/types";

const apiMock = vi.fn();
const uploadMock = vi.fn();
vi.mock("../../core/api", async (orig) => {
	const real = await orig<typeof import("../../core/api")>();
	return { ...real, api: (...a: unknown[]) => apiMock(...a), upload: (...a: unknown[]) => uploadMock(...a) };
});

import { ImageViewerHost } from "../../ui";
import { ChatCtx } from "./ChatContext";
import { ChatPage } from "./ChatPage";
import { ChatController } from "./chatStore";
import { Composer } from "./components/Composer";
import { PendingCards } from "./components/PendingCards";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { PendingBubble, TurnView } from "./components/TurnView";
import type { Turn } from "./lib/turns";
import { draftBook, queueFirstSend } from "./lib/drafts";
import { loadUnsent } from "./lib/unsent";
import { useRightDrawer } from "../panels/rightDrawerStore";
import { useSessions } from "../../core/stores/sessions";
import { PLAN_OFF } from "../../../src/features/chat/plan/planStatus";
class RO {
	observe() {}
	disconnect() {}
	unobserve() {}
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", RO);
	apiMock.mockReset();
	uploadMock.mockReset();
	apiMock.mockResolvedValue({});
	localStorage.clear();
	sessionStorage.clear();
	useRightDrawer.setState({ open: false, sessionId: null, tabBySession: {}, visitedBySession: {}, pendingSidechat: null, pendingMain: null });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const wrap = (c: ChatController, node: React.ReactNode) => (
	<ChatCtx.Provider value={{ controller: c, openActions: () => {}, openStat: () => {} }}>
		{node}
	</ChatCtx.Provider>
);

describe("Top Bar (Change 1)", () => {
	it("renders Menu (left), session header, 新建对话, and tool menu, while model picker is in composer", async () => {
		apiMock.mockImplementation(async (_method: string, path: string) => path.endsWith("/models") ? { models: [{ provider: "openai", id: "gpt-test", thinking: ["low", "high"] }], current: { provider: "openai", id: "gpt-test" }, thinkingLevel: "low", liveThinking: ["low", "high"] } : {});
		render(<ChatPage route={{ name: "chat", path: "/s/s1", params: { id: "s1" }, query: {} }} />);
		// Left: Menu
		expect(screen.getByRole("button", { name: "菜单" })).toBeTruthy();
		// Right: 新建对话 icon and 工作区 icon
		expect(screen.getByRole("button", { name: "新建对话" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "工作区" })).toBeTruthy();

		// Composer toolbar below composer input contains Model & Thinking level
		const modelBtn = screen.getByRole("button", { name: /当前模型/ });
		expect(modelBtn).toBeTruthy();

		// Tapping the model button in composer opens the compact model picker; thinking has its own trigger
		await act(async () => { fireEvent.click(modelBtn); });
		expect(screen.getByRole("dialog", { name: "模型" })).toBeTruthy();
		expect(screen.queryByRole("radiogroup", { name: "思考强度" })).toBeNull();
		expect(screen.getAllByText("gpt-test").length).toBeGreaterThan(0);
	});

	it("consumes a queued home prompt exactly once after the draft composer mounts in StrictMode", async () => {
		queueFirstSend("mobile-draft-home", "从首页开始");
		apiMock.mockImplementation(async (_method: string, path: string) => path.endsWith("/prompt-ex") ? new Promise(() => {}) : {});
		await act(async () => { render(<StrictMode><ChatPage route={{ name: "chat", path: "/s/mobile-draft-home", params: { id: "mobile-draft-home" }, query: {} }} /></StrictMode>); });
		expect(screen.getByText("从首页开始")).toBeTruthy();
		expect(screen.queryByText("会话不存在")).toBeNull();
		expect(apiMock).toHaveBeenCalledWith("POST", "/sessions/mobile-draft-home/prompt-ex", { text: "从首页开始", images: [] });
		expect(apiMock.mock.calls.filter(([, path]) => String(path).endsWith("/prompt-ex"))).toHaveLength(1);
	});

	it("creates a fresh draft session in 1 tap from 新建对话 and shows EmptyChatCanvas", async () => {
		const createSpy = vi.spyOn(useSessions.getState(), "createSession").mockResolvedValue({ id: "mobile-draft-new", mode: "code", cwd: "/repo/a" });
		const pushSpy = vi.spyOn(nav, "push").mockImplementation(() => {});
		useSessions.setState({
			list: [{ id: "s1", label: "#1", title: "旧对话", status: "idle", live: false, updatedAt: "2026-10-27T10:00:00Z", cwd: "/repo/a", mode: "code" }],
			byId: { s1: { id: "s1", label: "#1", title: "旧对话", status: "idle", live: false, updatedAt: "2026-10-27T10:00:00Z", cwd: "/repo/a", mode: "code" } },
		});
		try {
			render(<ChatPage route={{ name: "chat", path: "/s/s1", params: { id: "s1" }, query: {} }} />);
			expect(screen.queryByText("还没有消息")).toBeNull();
			expect(await screen.findByText(/中开始/)).toBeTruthy();
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "新建对话" }));
			});
			expect(createSpy).toHaveBeenCalledWith({ cwd: "/repo/a", mode: "code" });
			expect(pushSpy).toHaveBeenCalledWith("/s/mobile-draft-new");
		} finally {
			createSpy.mockRestore();
			pushSpy.mockRestore();
		}
	});
});

describe("Toolbar below composer (Change 2)", () => {
	it("renders model, thinking and context usage in the composer toolbar", async () => {
		const c = new ChatController("s1");
		c.store.setState({
			cstate: {
				model: "gpt-4o",
				thinkingLevel: "auto",
				contextTokens: 1000,
				contextWindow: 10000,
				contextPercent: 10,
				planMode: false,
				goal: null,
			},
		});

		render(wrap(c, <Composer sessionId="s1" />));

		const modelBtn = screen.getByRole("button", { name: /当前模型/ });
		expect(modelBtn).toBeTruthy();
		expect(modelBtn.textContent).toContain("gpt-4o");

		const ctxBtn = screen.getByRole("button", { name: /上下文用量/ });
		expect(ctxBtn).toBeTruthy();

		// Tapping context opens ContextSheet with compaction action
		fireEvent.click(ctxBtn);
		expect(screen.getByText("上下文窗口")).toBeTruthy();
		expect(screen.getByRole("button", { name: "压缩上下文" })).toBeTruthy();
	});

	it("shows a queue chip with the queued composition while messages wait in omp's queue", () => {
		const c = new ChatController("s1");
		c.store.setState({
			cstate: {
				model: "gpt-4o",
				queue: { steering: ["插一条"], followUp: ["排队一", "排队二"], liveSteered: 0 },
			},
		});
		render(wrap(c, <Composer sessionId="s1" />));
		expect(screen.getByText("排队 3 条 · 插话 1 · 后续 2")).toBeTruthy();

		// Delivered live steering and empty queues stay invisible.
		act(() => {
			c.store.setState({
				cstate: { model: "gpt-4o", queue: { steering: ["已插话"], followUp: [], liveSteered: 1 } },
			});
		});
		expect(screen.queryByText(/排队/)).toBeNull();
	});
});

describe("Composer attachment actions", () => {
 it("offers photo, file and desktop attachment actions alongside project controls", () => {
		const c = new ChatController("s1");
		render(wrap(c, <Composer sessionId="s1" />));

		const plusBtn = screen.getByRole("button", { name: "添加" });
		fireEvent.click(plusBtn);

		expect(screen.getByText("文件")).toBeTruthy();
		expect(screen.getByRole("button", { name: /电脑端文件/ })).toBeTruthy();
		expect(screen.getByText("切换工作目录")).toBeTruthy();
		expect(screen.getByText("目标")).toBeTruthy();
		expect(screen.getByText(/规划模式/)).toBeTruthy();
		expect(screen.getByText("草图")).toBeTruthy();

  expect(screen.getByRole("button", { name: "拍照" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "相册" })).toBeTruthy();
	});
});

describe("Composer send and stop controls", () => {
	it("has voice input mic button and send button", () => {
		const c = new ChatController("s1");
		render(wrap(c, <Composer sessionId="s1" />));

		expect(screen.getByRole("button", { name: "语音输入" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
	});

	it("shows Stop in the primary slot when idle-running and exposes both Send and Stop while typing", async () => {
		const c = new ChatController("s1");
		render(wrap(c, <Composer sessionId="s1" />));

		await act(async () => c.store.setState({ working: true }));
		expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "发送" })).toBeNull();

		const field = screen.getByRole("textbox");
		await act(async () => {
			fireEvent.input(field, { target: { value: "追问" } });
			await new Promise((resolve) => requestAnimationFrame(resolve));
		});
		expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false);
		expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
	});
});

describe("Plan mode (Change 7)", () => {
	it("shows '规划模式已启用' indicator when plan mode is active", async () => {
		const c = new ChatController("s1");
		c.store.setState({
			cstate: {
				model: "gpt-4o",
				thinkingLevel: "auto",
				contextTokens: 100,
				contextWindow: 1000,
				contextPercent: 10,
				planMode: true,
				goal: null,
			},
		});

		render(wrap(c, <Composer sessionId="s1" />));
		expect(screen.getByText("规划模式")).toBeTruthy();
	});

 it("stages a revision and preserves its draft while approval awaits authoritative execution", async () => {
		const c = new ChatController("s1");
		c.store.setState({
			cstate: {
				model: "gpt-4o",
				thinkingLevel: "auto",
				contextTokens: 100,
				contextWindow: 1000,
				contextPercent: 10,
				planMode: true,
    planStatus: { ...PLAN_OFF, enabled: true, phase: "review", content: "## Step 1: Design\n## Step 2: Implement" },
				goal: null,
			},
		});

		const turn: Turn = {
			type: "turn",
			id: "t1",
			user: null,
			steps: [],
			answer: { id: "ans-1", text: "## Step 1: Design\n## Step 2: Implement", images: [] },
			answerStat: null,
			start: 0,
			end: 0,
			lastAssistantId: "ans-1",
			src: [],
		};

  let draft = "";
  c.composer = { get: () => draft, set: (value) => { draft = value; }, focus: () => {} };
  apiMock.mockImplementation(async (_method: string, path: string) => path.endsWith("/composer-state") ? { planMode: false } : {});
		render(wrap(c, <TurnView turn={turn} isLast={true} sessionId="s1" />));

		expect(screen.getByText("计划已生成")).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Step 1: Design" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "执行计划" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "修改计划" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "复制计划" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "下载 .md 文件" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "修改计划" }));
  expect(draft).toContain("请按以下要求修改计划");
  expect(draft).toContain("Step 1: Design");
		expect(c.store.getState().cstate?.planMode).toBe(true);
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "执行计划" })); });
		expect(apiMock).toHaveBeenCalledWith("POST", "/sessions/s1/slash", { name: "plan-action", args: "approve keep" });
		expect(draft).toContain("请按以下要求修改计划");
		expect(screen.queryByText("计划已生成")).toBeNull();
		expect(c.store.getState().cstate?.planMode).toBe(false);
		c.dispose();
	});
});

describe("Text selection annotation (Change 8)", () => {
	it("stages quote and comment into composer for 主对话", () => {
		const c = new ChatController("s1");
		const container = document.createElement("div");
		container.textContent = "Selected message text";
		document.body.appendChild(container);

		render(wrap(c, <SelectionToolbar containerRef={{ current: container }} sessionId="s1" />));

		// Call stageAnnotation directly on controller to verify composer integration
		let staged = "";
		c.composer = { get: () => staged, set: (t) => { staged = t; } };
		c.stageAnnotation("Selected message text", "Needs revision");

		expect(staged).toContain("> Selected message text");
		expect(staged).toContain("Needs revision");
	});
});

describe("Question & Choice cards (Change 9)", () => {
	it("submits a custom single-select answer and retries a failed response", async () => {
		const c = new ChatController("s1");
		const questionEntry: PendingEntry = {
			request: {
				id: "q1",
				method: "select",
				title: "Choose deployment target (1/3)",
				options: ["Vercel (Recommended)", "Cloudflare Workers", "AWS Lambda"],
			},
		};

		const respond = vi.spyOn(c, "respond").mockRejectedValueOnce(new Error("request failed")).mockResolvedValue(undefined);
		render(wrap(c, <PendingCards />));
		act(() => c.store.setState({ pendings: [questionEntry] }));

		// Multi-step pagination (Question 1 of 3)
		expect(screen.getByLabelText("问题 1 / 3")).toBeTruthy();

		// Single-select radio items
		const radios = screen.getAllByRole("radio");
		expect(radios.length).toBe(3);

		const custom = screen.getByRole("textbox", { name: "其他回答" });
		fireEvent.change(custom, { target: { value: "Private deployment" } });
		expect(screen.getByRole("button", { name: "跳过" })).toBeTruthy();
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "提交" })); });
		expect(respond).toHaveBeenCalledWith(questionEntry, { value: "Private deployment" });
		expect(screen.getByText("提交失败")).toBeTruthy();
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重试" })); });
		expect(respond).toHaveBeenCalledTimes(2);
	});

	it("submits selected choices for a multi-select question", async () => {
		const c = new ChatController("s1");
		const multiEntry: PendingEntry = {
			request: {
				id: "q2",
				method: "select",
				title: "(0 selected) Select features",
				options: ["Feature A", "Feature B", "Feature C", " Done selecting"],
			},
		};

		const respondMulti = vi.spyOn(c, "respondMulti").mockResolvedValue(undefined);
		render(wrap(c, <PendingCards />));
		act(() => c.store.setState({ pendings: [multiEntry] }));

		const checkboxes = screen.getAllByRole("checkbox");
		expect(checkboxes.length).toBe(3);
		fireEvent.click(screen.getByRole("checkbox", { name: "Feature B" }));
		expect(screen.getByRole("checkbox", { name: "Feature B" }).getAttribute("aria-checked")).toBe("true");
		await act(async () => { fireEvent.click(screen.getByRole("button", { name: "提交" })); });
		expect(respondMulti).toHaveBeenCalledWith(multiEntry, ["Feature B"]);
		expect(screen.getByRole("button", { name: "跳过" })).toBeTruthy();
	});
});

describe("Draft slash bug fix (Change 10)", () => {
	it("uses nav.replace instead of nav.push when runCommand receives new sessionId from a draft", async () => {
		const draftId = "mobile-draft-123";
		const c = new ChatController(draftId);

		const replaceSpy = vi.spyOn(nav, "replace");
		const pushSpy = vi.spyOn(nav, "push");

		apiMock.mockResolvedValueOnce({ ok: true, sessionId: "sess-real-456" });

		await c.runCommand("new", "");

		expect(replaceSpy).toHaveBeenCalledWith("/s/sess-real-456");
		expect(pushSpy).not.toHaveBeenCalled();

		replaceSpy.mockRestore();
		pushSpy.mockRestore();
	});

	it("uses nav.push when runCommand receives new sessionId from a non-draft session", async () => {
		const regularId = "sess-existing-123";
		const c = new ChatController(regularId);

		const replaceSpy = vi.spyOn(nav, "replace");
		const pushSpy = vi.spyOn(nav, "push");

		apiMock.mockResolvedValueOnce({ ok: true, sessionId: "sess-forked-789" });

		await c.runCommand("fork", "");

		expect(pushSpy).toHaveBeenCalledWith("/s/sess-forked-789");
		expect(replaceSpy).not.toHaveBeenCalled();

		replaceSpy.mockRestore();
		pushSpy.mockRestore();
	});
});

describe("Chat UI at 390x844 viewport", () => {
	it("renders ChatPage cleanly without horizontal overflow at 390x844", () => {
		window.innerWidth = 390;
		window.innerHeight = 844;

		const { container } = render(
			<div style={{ width: 390, height: 844, overflowX: "hidden" }}>
				<ChatPage route={{ name: "chat", path: "/s/s1", params: { id: "s1" }, query: {} }} />
			</div>,
		);

		const root = container.firstElementChild as HTMLElement;
		expect(root).not.toBeNull();
		expect(root.scrollWidth).toBeLessThanOrEqual(390);

		// Verify key elements are mounted
		expect(screen.getByRole("button", { name: "菜单" })).toBeTruthy();
		expect(screen.getByRole("button", { name: /当前模型/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: "新建对话" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "工作区" })).toBeTruthy();
		expect(screen.getByLabelText("消息输入框")).toBeTruthy();
		expect(screen.getByRole("button", { name: "语音输入" })).toBeTruthy();
	});
});
describe("First-send recovery & draft plan-mode promotion", () => {
	it("restores queued first message into composer when controller.send returns false", async () => {
		queueFirstSend("s-fail", "不能丢失的首条消息");
		const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("QuotaExceededError");
		});
		try {
			await act(async () => {
				render(<ChatPage route={{ name: "chat", path: "/s/s-fail", params: { id: "s-fail" }, query: {} }} />);
			});
			const input = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
			expect(input.value).toBe("不能丢失的首条消息");
		} finally {
			setItemSpy.mockRestore();
		}
	});

	it("P2-3: restores rejected queued first goal alongside existing composer edits", async () => {
		const realId = "s-first-with-edits";
		draftBook.stash(realId, "激活期间补充说明", [
			{ id: 1, name: "wait.png", isImage: true, url: "blob:wait", status: "up" },
		]);
		queueFirstSend(realId, "每日巡检");
		await act(async () => {
			render(<ChatPage route={{ name: "chat", path: `/s/${realId}`, params: { id: realId }, query: {} }} />);
		});
		const input = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
		expect(input.value).toBe("每日巡检\n\n激活期间补充说明");
		expect(loadUnsent(realId)).toBe("每日巡检\n\n激活期间补充说明");
	});

	it("transfers draft text and replaces route when toggling plan mode materializes a draft", async () => {
		const draftId = "mobile-draft-plan-1";
		const realId = "sess-plan-real-1";
		const c = new ChatController(draftId);
		c.store.setState({ atts: [{ id: 1, name: "note.txt", isImage: false, url: "", status: "ok", path: "/tmp/note.txt" }] });
		const replaceSpy = vi.spyOn(nav, "replace");
		apiMock.mockImplementation(async (method: string, path: string) => {
			if (method === "POST" && path === `/sessions/${draftId}/plan-mode`) {
				return { on: true, sessionId: realId };
			}
			return {};
		});
		try {
			render(wrap(c, <Composer sessionId={draftId} />));
			const input = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
			fireEvent.input(input, { target: { value: "未发送的草稿" } });
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "添加" }));
			});
			await act(async () => {
				fireEvent.click(screen.getByRole("switch", { name: "规划模式" }));
			});
			expect(apiMock).toHaveBeenCalledWith("POST", `/sessions/${draftId}/plan-mode`, { on: true });
			expect(draftBook.restore(realId)).toMatchObject({
				text: "未发送的草稿",
				atts: [{ name: "note.txt", path: "/tmp/note.txt" }],
			});
			expect(replaceSpy).toHaveBeenCalledWith(`/s/${realId}`);
		} finally {
			replaceSpy.mockRestore();
			draftBook.forget(draftId);
			draftBook.forget(realId);
			c.dispose();
		}
	});
});

describe("Image and composer parity", () => {
	it("uses the unified default placeholder and separates numbered image thumbnails from file chips", () => {
		const c = new ChatController("s1");
		c.store.setState({
			atts: [
				{ id: 1, name: "first.png", isImage: true, url: "blob:first", status: "ok", path: "/tmp/first.png", image: { mime: "image/png", data: "QQ==" } },
				{ id: 2, name: "second.png", isImage: true, url: "blob:second", status: "err", err: "network", file: new File(["x"], "second.png", { type: "image/png" }) },
				{ id: 3, name: "spec.md", isImage: false, url: "", status: "ok", path: "/tmp/spec.md" },
			],
		});

		render(
			<>
				{wrap(c, <Composer sessionId="s1" />)}
				<ImageViewerHost />
			</>,
		);

		expect(screen.getByPlaceholderText("今天想做点什么？")).toBeTruthy();
		expect(screen.queryByText("first.png")).toBeNull();
		expect(screen.queryByText("second.png")).toBeNull();
		expect(screen.getByText("spec.md")).toBeTruthy();

		// Tap first image to open multi-image gallery (includes ready/previewable images)
		fireEvent.click(screen.getByRole("button", { name: "预览图片 first.png" }));
		expect(screen.getByText("1 / 2")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "下一张" }));
		expect(screen.getByText("2 / 2")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "关闭" }));

		// Tap failed image to retry upload
		uploadMock.mockResolvedValueOnce({ path: "/tmp/second.png" });
		fireEvent.click(screen.getByRole("button", { name: "重试上传 second.png" }));
		expect(uploadMock).toHaveBeenCalledTimes(1);
	});

	it("strips residual image markers in user & pending bubbles and opens multi-image gallery", () => {
		const c = new ChatController("s1");
		const turn: Turn = {
			type: "turn",
			id: "t-img",
			user: {
				id: "u-img",
				role: "user",
				kind: "user",
				parentId: null,
				text: "[Image #1: /tmp/a.png] [Image #2: /tmp/b.png] 看下这两张图",
				thinking: "",
				tools: [],
				images: [
					{ id: "i1", mime: "image/png", path: "/tmp/a.png", marker: "#1", width: null, height: null },
					{ id: "i2", mime: "image/png", path: "/tmp/b.png", marker: "#2", width: null, height: null },
				],
				ts: null,
				streaming: false,
			},
			steps: [],
			answer: null,
			answerStat: null,
			start: 0,
			end: 0,
			lastAssistantId: null,
			src: [],
		};

		render(
			<>
				{wrap(
					c,
					<>
						<TurnView turn={turn} isLast={false} sessionId="s1" />
						<PendingBubble text="[Image #1: /tmp/pending.png] 待发送" imageUrls={["blob:p1", "blob:p2"]} />
					</>,
				)}
				<ImageViewerHost />
			</>,
		);

		expect(screen.getByText("看下这两张图")).toBeTruthy();
		expect(screen.queryByText(/\[Image #1/)).toBeNull();
		expect(screen.getByText("待发送")).toBeTruthy();

		// Tapping the second image opens gallery directly at index 1 (2 / 2)
		const previewButtons = screen.getAllByRole("button", { name: "预览图片 #2" });
		fireEvent.click(previewButtons[0]);
		expect(screen.getByText("2 / 2")).toBeTruthy();

		// Simulate image load error and verify fallback + retry button
		const mainImg = within(screen.getByRole("dialog")).getByRole("img", { name: "#2" });
		fireEvent.error(mainImg);
		expect(screen.getByText("图片加载失败")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		expect(screen.queryByText("图片加载失败")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "关闭" }));
	});

	it("sends native images payload without [Image #N] markers and keeps optimistic text clean", async () => {
		const c = new ChatController("s1");
		c.store.setState({
			atts: [
				{ id: 1, name: "shot.png", isImage: true, url: "blob:shot", status: "ok", path: "/tmp/shot.png", image: { mime: "image/png", data: "QQ==" } },
				{ id: 2, name: "notes.txt", isImage: false, url: "", status: "ok", path: "/tmp/notes.txt" },
			],
		});

		await c.send("分析一下", "followUp");
		expect(apiMock).toHaveBeenCalledWith("POST", "/sessions/s1/prompt-ex", {
			text: "[文件 #1: /tmp/notes.txt] 分析一下",
			images: [{ mime: "image/png", data: "QQ==" }],
		});
		expect(c.state.optimistic[0]).toMatchObject({
			text: "[文件 #1: /tmp/notes.txt] 分析一下",
			imageUrls: ["blob:shot"],
		});
	});

	it("keeps /automate text when setAutomationMode fails or when follow-up send returns false", async () => {
		const c = new ChatController("s-comp");
		const setAutoSpy = vi.spyOn(c, "setAutomationMode").mockRejectedValueOnce(new Error("offline"));
		const sendSpy = vi.spyOn(c, "send");
		render(wrap(c, <Composer sessionId="s-comp" />));

		const box = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
		await act(async () => {
			fireEvent.input(box, { target: { value: "/automate 每小时检查日志" } });
			await new Promise((r) => requestAnimationFrame(r));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "发送" }));
		});
		expect(setAutoSpy).toHaveBeenCalledWith(true, "每小时检查日志", "/automate 每小时检查日志");
		expect(box.value).toBe("/automate 每小时检查日志");
		expect(sendSpy).not.toHaveBeenCalled();

		setAutoSpy.mockResolvedValueOnce("s-comp");
		sendSpy.mockResolvedValueOnce(false);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "发送" }));
		});
		expect(sendSpy).toHaveBeenCalledWith("每小时检查日志", expect.any(String), { preserveComposer: true });
		expect(box.value).toBe("/automate 每小时检查日志");
		c.dispose();
	});

	it("preserves extra text typed while /automate activation is in flight", async () => {
		const c = new ChatController("s-comp-2");
		let resolveAuto!: (id: string) => void;
		vi.spyOn(c, "setAutomationMode").mockImplementationOnce(
			() => new Promise<string>((r) => { resolveAuto = r; }),
		);
		const sendSpy = vi.spyOn(c, "send").mockResolvedValue(true);
		render(wrap(c, <Composer sessionId="s-comp-2" />));

		const box = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
		await act(async () => {
			fireEvent.input(box, { target: { value: "/automate 检查日志" } });
			await new Promise((r) => requestAnimationFrame(r));
		});
		fireEvent.click(screen.getByRole("button", { name: "发送" }));
		// User continues typing while POST /automation is pending
		await act(async () => {
			fireEvent.input(box, { target: { value: "/automate 检查日志 补充说明" } });
			await new Promise((r) => requestAnimationFrame(r));
		});
		await act(async () => {
			resolveAuto("s-comp-2");
			await Promise.resolve();
		});
		expect(sendSpy).toHaveBeenCalledWith("检查日志", expect.any(String), { preserveComposer: true });
		expect(box.value).toBe("补充说明");
		c.dispose();
	});
});
