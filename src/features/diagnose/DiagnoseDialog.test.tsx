// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";

const mocks = vi.hoisted(() => ({ build: vi.fn(), dispatch: vi.fn(), start: vi.fn(), close: vi.fn(), select: vi.fn(), t: (key: string) => key }));
vi.mock("../../lib/ipc", () => ({ diagnoseBuildPrompt: mocks.build, dispatchPrompt: mocks.dispatch, rpcStart: mocks.start }));
vi.mock("../../stores/language", () => ({ useT: () => ({ t: mocks.t }) }));
vi.mock("../../lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../components/Modal", () => ({ Modal: ({ children }: PropsWithChildren) => <div role="dialog">{children}</div> }));
// Hoisted mock factories must load zustand before this test module's imports initialize.
vi.mock("../../stores/sessions", async () => {
 const { create } = await import("zustand");
 return { useSessions: create(() => ({ sessions: {} })) };
});
vi.mock("../../stores/ui", async () => {
 const { create } = await import("zustand");
 return { useUi: create(() => ({ modal: null, closeModal: mocks.close, selectSession: mocks.select })) };
});
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import { DiagnoseDialog } from "./DiagnoseDialog";

const sessions = () => Object.fromEntries(["target", "first", "chosen"].map((id) => [id, { id, title: id, cwd: "/project", status: "idle", mode: "code" }]));
const open = (id = "target") => useUi.setState({ modal: { name: "diagnose", props: { sessionId: id } } });
const refresh = () => act(() => { useSessions.setState({ sessions: sessions() as never }); });
beforeEach(() => {
 vi.clearAllMocks();
 mocks.build.mockReset().mockResolvedValue("generated prompt");
 mocks.dispatch.mockReset().mockResolvedValue(undefined);
 mocks.start.mockReset().mockResolvedValue({ sessionId: "new-diagnoser" });
 useSessions.setState({ sessions: sessions() as never });
 open();
});
afterEach(cleanup);

describe("diagnosis dialog lifecycle", () => {
 it("defaults to new diagnosis session and preserves edited prompt and existing selection through catalog refresh", async () => {
  render(<DiagnoseDialog />);
  const prompt = await screen.findByPlaceholderText("diagnose.promptPlaceholder");
  await waitFor(() => expect((prompt as HTMLTextAreaElement).value).toBe("generated prompt"));
  expect(screen.getByPlaceholderText("diagnose.modelPlaceholder")).toBeTruthy();
  fireEvent.change(prompt, { target: { value: "user edited prompt" } });
  fireEvent.click(screen.getByText("diagnose.tabExisting"));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "chosen" } });
  refresh();
  expect((screen.getByPlaceholderText("diagnose.promptPlaceholder") as HTMLTextAreaElement).value).toBe("user edited prompt");
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("chosen");
  expect(mocks.build).toHaveBeenCalledTimes(1);
 });

 it("filters busy sessions and hides existing tab when no idle candidates remain", async () => {
  useSessions.setState({
   sessions: {
    target: { id: "target", title: "target", cwd: "/project", status: "error", mode: "code" },
    busy1: { id: "busy1", title: "busy1", cwd: "/project", status: "working", mode: "code" },
   } as never,
  });
  render(<DiagnoseDialog />);
  await screen.findByPlaceholderText("diagnose.promptPlaceholder");
  expect(screen.queryByText("diagnose.tabExisting")).toBeNull();
  expect(screen.getByPlaceholderText("diagnose.modelPlaceholder")).toBeTruthy();
 });

 it("preserves new-session model and target type through catalog refresh", async () => {
  render(<DiagnoseDialog />);
  await screen.findByPlaceholderText("diagnose.promptPlaceholder");
  fireEvent.change(screen.getByPlaceholderText("diagnose.modelPlaceholder"), { target: { value: "custom-model" } });
  refresh();
  expect((screen.getByPlaceholderText("diagnose.modelPlaceholder") as HTMLInputElement).value).toBe("custom-model");
  fireEvent.click(screen.getByText("diagnose.startDiagnosis"));
  await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
  expect(mocks.start).toHaveBeenCalledWith({ cwd: "/project", mode: "code", model: "custom-model" });
 });

 it("keeps sending locked across refresh and rapid keyboard submissions", async () => {
  let finish!: () => void;
  mocks.dispatch.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<DiagnoseDialog />);
  const prompt = await screen.findByPlaceholderText("diagnose.promptPlaceholder");
  fireEvent.click(screen.getByText("diagnose.startDiagnosis"));
  await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
  refresh();
  fireEvent.keyDown(prompt, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(prompt, { key: "Enter", metaKey: true });
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  expect(screen.getByText("diagnose.startingDiagnosis").closest("button")?.disabled).toBe(true);
  expect(mocks.build).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
 });

 it("ignores a late prompt response from a previous target", async () => {
  let first!: (value: string) => void;
  mocks.build.mockImplementationOnce(() => new Promise<string>((resolve) => { first = resolve; }));
  render(<DiagnoseDialog />);
  act(() => { open("first"); });
  await screen.findByPlaceholderText("diagnose.promptPlaceholder");
  await act(async () => { first("stale old prompt"); });
  expect((screen.getByPlaceholderText("diagnose.promptPlaceholder") as HTMLTextAreaElement).value).toBe("generated prompt");
 });
 it("retries dispatch without overwriting hand-edited prompt or rebuilding summary", async () => {
  mocks.dispatch.mockRejectedValueOnce(new Error("send failed"));
  render(<DiagnoseDialog />);
  const prompt = await screen.findByPlaceholderText("diagnose.promptPlaceholder");
  await waitFor(() => expect((prompt as HTMLTextAreaElement).value).toBe("generated prompt"));
  fireEvent.change(prompt, { target: { value: "custom edited prompt" } });
  fireEvent.click(screen.getByText("diagnose.startDiagnosis"));
  await screen.findByText("send failed");
  fireEvent.click(screen.getByText("diagnose.retrySend"));
  await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(2));
  expect(mocks.dispatch).toHaveBeenLastCalledWith("new-diagnoser", "custom edited prompt");
  expect(mocks.build).toHaveBeenCalledTimes(1);
  expect(mocks.start).toHaveBeenCalledTimes(1);
 });

 it("does not let an earlier send close or navigate a reopened diagnosis", async () => {
  let finish!: () => void;
  mocks.dispatch.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<DiagnoseDialog />);
  await screen.findByPlaceholderText("diagnose.promptPlaceholder");
  fireEvent.click(screen.getByText("diagnose.startDiagnosis"));
  await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
  act(() => { useUi.setState({ modal: null }); });
  act(() => { open("first"); });
  await screen.findByPlaceholderText("diagnose.promptPlaceholder");
  await act(async () => { finish(); });
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
  expect((screen.getByPlaceholderText("diagnose.promptPlaceholder") as HTMLTextAreaElement).value).toBe("generated prompt");
 });

 it("marks selected existing session unavailable instead of silently substituting when it becomes busy or disappears", async () => {
  render(<DiagnoseDialog />);
  await screen.findByPlaceholderText("diagnose.promptPlaceholder");
  fireEvent.click(screen.getByText("diagnose.tabExisting"));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "chosen" } });

  // Selected session becomes busy while another idle session "first" still exists
  act(() => {
   useSessions.setState({
    sessions: {
     target: { id: "target", title: "target", cwd: "/project", status: "error", mode: "code" },
     first: { id: "first", title: "first", cwd: "/project", status: "idle", mode: "code" },
     chosen: { id: "chosen", title: "chosen", cwd: "/project", status: "working", mode: "code" },
    } as never,
   });
  });
  expect(screen.getByRole("alert").textContent).toBe("diagnose.selectedSessionBusy");
  const submitBtn = screen.getByText("diagnose.startDiagnosis").closest("button") as HTMLButtonElement;
  expect(submitBtn.disabled).toBe(true);
  fireEvent.click(submitBtn);
  expect(mocks.dispatch).not.toHaveBeenCalled();

  // Remaining candidate disappears completely -> still stays on existing tab with unavailable error
  act(() => {
   useSessions.setState({
    sessions: {
     target: { id: "target", title: "target", cwd: "/project", status: "error", mode: "code" },
    } as never,
   });
  });
  expect(screen.getByRole("alert").textContent).toBe("diagnose.selectedSessionUnavailable");
  expect((screen.getByText("diagnose.startDiagnosis").closest("button") as HTMLButtonElement).disabled).toBe(true);
 });

 it("reuses createdSessionId on retry and resets it if user changes model or destination", async () => {
  mocks.start
   .mockResolvedValueOnce({ sessionId: "new-diagnoser-1" })
   .mockResolvedValueOnce({ sessionId: "new-diagnoser-2" });
  mocks.dispatch
   .mockRejectedValueOnce(new Error("send failed"))
   .mockRejectedValueOnce(new Error("send failed again"))
   .mockResolvedValueOnce(undefined);

  render(<DiagnoseDialog />);
  await screen.findByPlaceholderText("diagnose.promptPlaceholder");

  fireEvent.click(screen.getByText("diagnose.startDiagnosis"));
  await screen.findByText("send failed");
  expect(mocks.start).toHaveBeenCalledTimes(1);

  // Retrying dispatch reuses new-diagnoser-1 without creating a duplicate session
  fireEvent.click(screen.getByText("diagnose.retrySend"));
  await screen.findByText("send failed again");
  expect(mocks.start).toHaveBeenCalledTimes(1);
  expect(mocks.dispatch).toHaveBeenLastCalledWith("new-diagnoser-1", "generated prompt");

  // Changing model resets createdSessionId so next submit starts a fresh session with the new model
  fireEvent.change(screen.getByPlaceholderText("diagnose.modelPlaceholder"), { target: { value: "sonnet" } });
  fireEvent.click(screen.getByText("diagnose.startDiagnosis"));
  await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(3));
  expect(mocks.start).toHaveBeenCalledTimes(2);
  expect(mocks.start).toHaveBeenLastCalledWith({ cwd: "/project", mode: "code", model: "sonnet" });
  expect(mocks.dispatch).toHaveBeenLastCalledWith("new-diagnoser-2", "generated prompt");
 });

 it("does not let an in-flight dispatch close modals or navigate after unmount (M8)", async () => {
  let finish!: () => void;
  mocks.dispatch.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const view = render(<DiagnoseDialog />);
  await screen.findByPlaceholderText("diagnose.promptPlaceholder");
  fireEvent.click(screen.getByText("diagnose.startDiagnosis"));
  await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));

  // Unmount dialog while dispatch is still pending (e.g., modal dismissed)
  view.unmount();
  await act(async () => { finish(); });
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
 });

 it.each(["working", "awaiting_approval", "awaiting_answer"] as const)(
  "excludes %s sessions from existing targets and blocks submit if selected target enters that state (M8)",
  async (busyStatus) => {
   useSessions.setState({
    sessions: {
     target: { id: "target", title: "target", cwd: "/project", status: "error", mode: "code" },
     busy: { id: "busy", title: "busy", cwd: "/project", status: busyStatus, mode: "code" },
     idleOne: { id: "idleOne", title: "idleOne", cwd: "/project", status: "idle", mode: "code" },
    } as never,
   });
   render(<DiagnoseDialog />);
   await screen.findByPlaceholderText("diagnose.promptPlaceholder");
   fireEvent.click(screen.getByText("diagnose.tabExisting"));
   const options = Array.from(screen.getByRole("combobox").querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value);
   expect(options).toEqual(["idleOne"]);

   // Now idleOne enters busyStatus -> submit is blocked with busy alert
   act(() => {
    useSessions.setState({
     sessions: {
      target: { id: "target", title: "target", cwd: "/project", status: "error", mode: "code" },
      idleOne: { id: "idleOne", title: "idleOne", cwd: "/project", status: busyStatus, mode: "code" },
     } as never,
    });
   });
   expect(screen.getByRole("alert").textContent).toBe("diagnose.selectedSessionBusy");
   expect((screen.getByText("diagnose.startDiagnosis").closest("button") as HTMLButtonElement).disabled).toBe(true);
  },
 );
 });
});
