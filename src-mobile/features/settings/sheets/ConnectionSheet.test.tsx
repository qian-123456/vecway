// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	bytesToBase64,
	type NativeBridge,
	type NativeChannel,
	type NativeEndpointStatus,
} from "../../../core/nativeBridge";
import { stopEvents } from "../../../core/sse";
import { useConnection } from "../../../core/stores/connection";
import { DialogHost } from "../../../ui";
import { ConnectionSheet } from "./ConnectionSheet";

beforeEach(() => {
	delete window.__VECWAY_NATIVE__;
	useConnection.setState({ phase: "open", error: null });
});
afterEach(() => {
	stopEvents();
	cleanup();
	delete window.__VECWAY_NATIVE__;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("current device name", () => {
	it("saves an optional name for the authenticated device and allows restoring the default", async () => {
		const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetcher);
		render(<ConnectionSheet open onClose={() => {}} />);
		const input = screen.getByLabelText("设备名称（可选）");
		fireEvent.change(input, { target: { value: "  工作手机  " } });
		fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
		await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
		expect(fetcher).toHaveBeenCalledWith("/api/device/name", expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify({ name: "工作手机" }) }));
		await screen.findByRole("button", { name: "保存名称" });
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
		await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		expect(fetcher.mock.calls[1][1].body).toBe(JSON.stringify({ name: "" }));
	});

	it("shows a revoked pairing and keeps the connection unauthorized", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
		render(<ConnectionSheet open onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
		expect((await screen.findByRole("alert")).textContent).toContain("配对已失效或被撤销");
		expect(useConnection.getState().phase).toBe("unauthorized");
	});
});

describe("ConnectionSheet native mode", () => {
	const utf8 = new TextEncoder();
	const FULL_FINGERPRINT = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

	function installBridge(initialStatus: NativeEndpointStatus) {
		let current = initialStatus;
		const getConnectionStatus = vi.fn(async () => current);
		const updateEndpoints = vi.fn(async (endpoints: Partial<NativeEndpointStatus["candidates"]> & { certSha256?: string }) => {
			const { certSha256, ...candidatePatch } = endpoints;
			current = {
				...current,
				activeUrl: candidatePatch.lanTls || current.activeUrl,
				certSha256: current.certSha256 ?? certSha256 ?? null,
				candidates: { ...current.candidates, ...candidatePatch },
			};
			return current;
		});
		const switchChannel = vi.fn(async (channel: NativeChannel | null) => {
			const nextChannel: NativeChannel | null =
				channel ?? (current.candidates.lanTls && current.certSha256 ? "lan_tls" : current.candidates.tunnel ? "tunnel" : null);
			current = {
				...current,
				preferredChannel: channel,
				activeChannel: nextChannel,
				activeUrl:
					nextChannel === "lan_tls"
						? current.candidates.lanTls ?? current.activeUrl
						: nextChannel === "tunnel"
							? current.candidates.tunnel ?? current.activeUrl
							: nextChannel === "ipv6_tls"
								? current.candidates.ipv6 ?? current.activeUrl
								: null,
			};
			return current;
		});
		const reprobeConnection = vi.fn(async () => {
			current = {
				...current,
				activeChannel: "tunnel",
				activeUrl: "https://demo.trycloudflare.com",
			};
			return current;
		});
		const openPairScanner = vi.fn(async () => ({ ok: true, status: current }));
		const unpair = vi.fn(async () => {});
		const bridge: NativeBridge = {
			platform: "ios",
			appVersion: "0.2.0",
			httpRequest: vi.fn(async () => ({
				status: 200,
				headers: { "content-type": "application/json" },
				bodyBase64: bytesToBase64(utf8.encode("[]")),
			})),
			openSse: vi.fn(() => vi.fn()),
			getConnectionStatus,
			openPairScanner,
			updateEndpoints,
			reprobeConnection,
			switchChannel,
			unpair,
		};
		window.__VECWAY_NATIVE__ = bridge;
		return { bridge, getConnectionStatus, updateEndpoints, switchChannel, reprobeConnection, openPairScanner, unpair };
	}

	it("hides location.origin (vecway://app) and shows active channel, active URL, and full cert fingerprint", async () => {
		installBridge({
			paired: true,
			activeChannel: "lan_tls",
			activeUrl: "https://192.168.1.10:7790",
			certSha256: FULL_FINGERPRINT,
			candidates: { lanTls: "https://192.168.1.10:7790" },
		});

		render(<ConnectionSheet open onClose={() => {}} />);

		expect(await screen.findByText("局域网 TLS")).toBeDefined();
		expect(screen.getByText("https://192.168.1.10:7790")).toBeDefined();
		expect(screen.getByText(FULL_FINGERPRINT)).toBeDefined();
		expect(screen.queryByText("vecway://app")).toBeNull();
		expect(screen.queryByText("当前地址")).toBeNull();
		if (window.location.origin) {
			expect(screen.queryByText(window.location.origin)).toBeNull();
		}
	});

	it("rejects plaintext http:// endpoints client-side and saves valid https:// endpoints", async () => {
		const { updateEndpoints } = installBridge({
			paired: true,
			activeChannel: "lan_tls",
			activeUrl: "https://192.168.1.10:7790",
			certSha256: FULL_FINGERPRINT,
			candidates: { lanTls: "https://192.168.1.10:7790" },
		});

		render(<ConnectionSheet open onClose={() => {}} />);
		await screen.findByText("局域网 TLS");

		const lanInput = screen.getByLabelText("局域网 TLS 地址") as HTMLInputElement;
		fireEvent.change(lanInput, { target: { value: "http://192.168.1.10:7788" } });
		fireEvent.click(screen.getByRole("button", { name: "保存端点" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("http://");
		expect(updateEndpoints).not.toHaveBeenCalled();

		fireEvent.change(lanInput, { target: { value: "https://192.168.1.99:7790/" } });
		fireEvent.click(screen.getByRole("button", { name: "保存端点" }));
		await waitFor(() => expect(updateEndpoints).toHaveBeenCalledTimes(1));
		expect(updateEndpoints).toHaveBeenCalledWith({ lanTls: "https://192.168.1.99:7790" });

		const domainInput = screen.getByLabelText("Cloudflare / 公网域名地址") as HTMLInputElement;
		fireEvent.change(domainInput, { target: { value: "omp.example.com/" } });
		fireEvent.click(screen.getByRole("button", { name: "保存端点" }));
		await waitFor(() => expect(updateEndpoints).toHaveBeenCalledTimes(2));
		expect(updateEndpoints).toHaveBeenLastCalledWith({
			lanTls: "https://192.168.1.99:7790",
			tunnel: "https://omp.example.com",
		});
	});

	it("delegates reprobeConnection, openPairScanner, and confirmed unpair to native bridge", async () => {
		const onClose = vi.fn();
		const { reprobeConnection, openPairScanner, unpair } = installBridge({
			paired: true,
			activeChannel: "lan_tls",
			activeUrl: "https://192.168.1.10:7790",
			certSha256: FULL_FINGERPRINT,
			candidates: { lanTls: "https://192.168.1.10:7790" },
		});

		render(
			<>
				<ConnectionSheet open onClose={onClose} />
				<DialogHost />
			</>,
		);
		await screen.findByText("局域网 TLS");

		fireEvent.click(screen.getByRole("button", { name: "重新探测连接" }));
		await waitFor(() => expect(reprobeConnection).toHaveBeenCalledTimes(1));
		expect(await screen.findByText("Cloudflare / 公网域名")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "重新扫码配对" }));
		await waitFor(() => expect(openPairScanner).toHaveBeenCalledTimes(1));

		fireEvent.click(screen.getByRole("button", { name: "解除配对" }));
		await waitFor(() => expect(screen.getAllByRole("dialog").length).toBeGreaterThanOrEqual(2));
		const dialogs = screen.getAllByRole("dialog");
		const confirmDialog = dialogs[dialogs.length - 1]!;
		fireEvent.click(within(confirmDialog).getByRole("button", { name: "解除配对" }));
		await waitFor(() => expect(unpair).toHaveBeenCalledTimes(1));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("switches between tunnel, LAN, and auto channels without rescanning", async () => {
		const { switchChannel } = installBridge({
			paired: true,
			activeChannel: "tunnel",
			preferredChannel: "tunnel",
			activeUrl: "https://omp.example.com",
			certSha256: FULL_FINGERPRINT,
			candidates: {
				lanTls: "https://192.168.1.10:7790",
				tunnel: "https://omp.example.com",
			},
		});

		render(<ConnectionSheet open onClose={() => {}} />);
		fireEvent.click(await screen.findByRole("button", { name: /连接方式/ }));
		const lanItem = await screen.findByRole("menuitemradio", { name: /局域网直连/ });
		fireEvent.click(lanItem);
		await waitFor(() => expect(switchChannel).toHaveBeenCalledWith("lan_tls"));
		expect(await screen.findByText("局域网 TLS")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: /连接方式/ }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: /自动优选/ }));
		await waitFor(() => expect(switchChannel).toHaveBeenCalledWith(null));
	});

	it("offers one-tap LAN adoption for domain-paired users and unlocks manual LAN+cert entry", async () => {
		const { updateEndpoints, switchChannel } = installBridge({
			paired: true,
			activeChannel: "tunnel",
			preferredChannel: null,
			activeUrl: "https://omp.example.com",
			certSha256: null,
			candidates: { tunnel: "https://omp.example.com" },
		});

		render(
			<ConnectionSheet
				open
				onClose={() => {}}
				mobile={{ lanTlsUrl: "https://192.168.1.10:7790", certSha256: FULL_FINGERPRINT }}
			/>,
		);

		// LAN input and optional SHA-256 fingerprint input are unlocked (never forcing QR rescan)
		const lanInput = (await screen.findByLabelText("局域网 TLS 地址")) as HTMLInputElement;
		expect(lanInput.disabled).toBe(false);
		expect(screen.getByLabelText("局域网证书指纹 (SHA-256，可选)")).toBeDefined();

		// One-tap trust & switch adopts the desktop LAN TLS endpoint and cert fingerprint
		fireEvent.click(screen.getByRole("button", { name: "信任并切换至局域网直连" }));
		await waitFor(() =>
			expect(updateEndpoints).toHaveBeenCalledWith({
				lanTls: "https://192.168.1.10:7790",
				certSha256: FULL_FINGERPRINT,
			}),
		);
		await waitFor(() => expect(switchChannel).toHaveBeenCalledWith("lan_tls"));
	});
});
