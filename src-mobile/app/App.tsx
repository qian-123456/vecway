import { Globe, QrCode, ShieldAlert } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { ROUTES } from "./routes";
import { ConnectionBanner } from "./ConnectionBanner";
import { ErrorBoundary } from "./ErrorBoundary";
import { PairingNotice } from "./PairingNotice";
import { useTheme } from "./theme";
import { installViewportTracking } from "./viewport";
import { errorMessage } from "../core/api";
import { useRoute } from "../core/nav";
import {
	EMPTY_NATIVE_STATUS,
	NATIVE_CHANNEL_LABEL,
	getNativeBridge,
	isNativeApp,
	nativeHaptic,
	notifyNativeConnectionStatus,
	subscribeNativeConnectionStatus,
	type NativeEndpointStatus,
	type NativePinMismatch,
} from "../core/nativeBridge";
import { startEvents, stopEvents } from "../core/sse";
import { useConnection } from "../core/stores/connection";
import { startSessionsSync, useSessions } from "../core/stores/sessions";
import { AppMark } from "../ui/AppMark";
import { Button } from "../ui/Button";
import { DialogHost, confirm } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { ImageViewerHost } from "../ui/ImageViewer";
import { Spinner } from "../ui/Spinner";
import { ToastHost, toast } from "../ui/Toast";

function PageFallback() {
	return (
		<div className="flex flex-1 items-center justify-center text-m-text-3">
			<Spinner size={22} />
		</div>
	);
}

/** Renders the lazy page of the current route. `key` = path so a page never inherits another page's state. */
function RouteView() {
	const route = useRoute();
	if (route.name === "notFound") {
		return <EmptyState title="页面不存在" hint={route.path} />;
	}
	const Page = ROUTES[route.name];
	return (
		<ErrorBoundary resetKey={route.path}>
			<Suspense fallback={<PageFallback />}>
				<Page key={route.path} route={route} />
			</Suspense>
		</ErrorBoundary>
	);
}

async function triggerNativePair(setError: (msg: string | null) => void, mode?: "scan" | "domain"): Promise<void> {
	const bridge = getNativeBridge();
	if (!bridge) return;
	setError(null);
	const res = await bridge.openPairScanner(mode ? { mode } : undefined);
	if (res.ok) {
		const next = res.status ?? (await bridge.getConnectionStatus());
		useConnection.getState().reset();
		notifyNativeConnectionStatus(next);
		if (next.paired && !next.pinMismatch) {
			startEvents();
			void useSessions.getState().refresh().catch(() => {});
		}
		nativeHaptic("success");
		toast("配对成功", { kind: "success" });
		return;
	}
	if (res.error) {
		setError(res.error);
		toast(res.error, { kind: "error" });
	}
}

function NativeUnpairedScreen() {
	const [scanning, setScanning] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onPair = async (mode: "scan" | "domain") => {
		if (scanning) return;
		setScanning(true);
		try {
			await triggerNativePair(setError, mode);
		} catch (e) {
			const msg = errorMessage(e, mode === "domain" ? "域名配对失败" : "扫码配对失败");
			setError(msg);
			toast(msg, { kind: "error" });
		} finally {
			setScanning(false);
		}
	};

	return (
		<main
			className="m-page relative flex flex-1 flex-col items-center justify-center gap-4 px-8 py-12 text-center"
			style={{
				paddingTop: "max(48px, var(--m-safe-top))",
				paddingBottom: "max(48px, var(--m-safe-bottom))",
				paddingLeft: "max(32px, var(--m-safe-left))",
				paddingRight: "max(32px, var(--m-safe-right))",
			}}
		>
			<div className="pointer-events-none absolute inset-0" style={{ background: "var(--m-glow)" }} aria-hidden />
			<div className="relative flex h-18 w-18 items-center justify-center rounded-[22px] border border-m-border bg-m-card shadow-m-card">
				<AppMark size={52} />
			</div>
			<h1 className="relative text-m-lg font-semibold tracking-[-0.01em] text-m-text">连接 Vecway 桌面端</h1>
			<p className="relative max-w-xs text-m-sm break-words text-m-text-3">
				在电脑上打开 Vecway，进入「设置 → 手机访问」，扫描配对二维码，或直接输入 Cloudflare / 公网域名与配对码建立加密连接。
			</p>
			{error && (
				<p role="alert" className="relative max-w-xs text-m-sm break-words text-m-danger">
					{error}
				</p>
			)}
			<div className="relative mt-2 flex flex-wrap justify-center gap-3">
				<Button variant="primary" icon={<QrCode size={18} />} busy={scanning} onClick={() => void onPair("scan")}>
					扫码配对
				</Button>
				<Button variant="tonal" icon={<Globe size={18} />} disabled={scanning} onClick={() => void onPair("domain")}>
					用域名连接
				</Button>
			</div>
		</main>
	);
}

/** Hard-blocking certificate pin mismatch view: zero "ignore/continue" option. */
function NativePinMismatchScreen({ mismatch }: { mismatch: NativePinMismatch }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onRepair = async () => {
		if (busy) return;
		setBusy(true);
		try {
			await triggerNativePair(setError);
		} catch (e) {
			const msg = errorMessage(e, "扫码配对失败");
			setError(msg);
			toast(msg, { kind: "error" });
		} finally {
			setBusy(false);
		}
	};

	const onUnpair = async () => {
		const bridge = getNativeBridge();
		if (!bridge || busy) return;
		const ok = await confirm({
			title: "解除配对",
			message: "将清除本机保存的设备令牌与证书指纹，并需要重新扫码配对。",
			confirmText: "解除配对",
			danger: true,
		});
		if (!ok) return;
		setBusy(true);
		try {
			await bridge.unpair();
			stopEvents();
			useConnection.getState().reset();
			notifyNativeConnectionStatus(EMPTY_NATIVE_STATUS);
			toast("已解除配对");
		} catch (e) {
			toast(`解除配对失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setBusy(false);
		}
	};

	return (
		<main
			className="m-page flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-10 text-center"
			style={{
				paddingTop: "max(40px, var(--m-safe-top))",
				paddingBottom: "max(40px, var(--m-safe-bottom))",
				paddingLeft: "max(24px, var(--m-safe-left))",
				paddingRight: "max(24px, var(--m-safe-right))",
			}}
		>
			<div className="flex h-14 w-14 items-center justify-center rounded-m-pill bg-m-danger-bg text-m-danger">
				<ShieldAlert size={28} />
			</div>
			<h1 className="text-m-lg font-semibold text-m-text">证书指纹不匹配，已阻止连接</h1>
			<p className="max-w-sm text-m-sm break-words text-m-text-2">
				服务器返回的 TLS 证书与配对时锁定的指纹不一致。为保护会话安全，已拒绝本次连接，请核对电脑端证书后重新扫码配对。
			</p>
			<div className="w-full max-w-md space-y-2 rounded-m-lg bg-m-surface p-4 text-left text-m-xs">
				<div className="text-m-text-3">
					通道：{NATIVE_CHANNEL_LABEL[mismatch.channel]} · 主机：<span className="font-m-mono text-m-text">{mismatch.host}</span>
				</div>
				<div>
					<div className="text-m-text-3">锁定指纹 (SHA-256)</div>
					<div className="m-selectable font-m-mono break-all text-m-text">{mismatch.expectedSha256}</div>
				</div>
				<div>
					<div className="text-m-text-3">实际证书指纹 (SHA-256)</div>
					<div className="m-selectable font-m-mono break-all text-m-danger">{mismatch.actualSha256}</div>
				</div>
			</div>
			{error && (
				<p role="alert" className="max-w-sm text-m-sm break-words text-m-danger">
					{error}
				</p>
			)}
			<div className="flex flex-wrap justify-center gap-3 pt-2">
				<Button variant="primary" icon={<QrCode size={18} />} busy={busy} onClick={() => void onRepair()}>
					重新扫码配对
				</Button>
				<Button variant="danger" disabled={busy} onClick={() => void onUnpair()}>
					解除配对
				</Button>
			</div>
		</main>
	);
}

export function App({
	paired = false,
	nativeStatus: initialNativeStatus,
}: {
	paired?: boolean;
	nativeStatus?: NativeEndpointStatus | null;
}) {
	const native = isNativeApp();
	const [nativeStatus, setNativeStatus] = useState<NativeEndpointStatus | null>(() =>
		native ? (initialNativeStatus ?? null) : null,
	);
	useTheme();
	useEffect(() => installViewportTracking(), []);
	useEffect(() => startSessionsSync(), []);
	useEffect(() => {
		if (!native) return;
		let active = true;
		const unsubscribe = subscribeNativeConnectionStatus((next) => {
			if (active) setNativeStatus(next);
		});
		if (initialNativeStatus === undefined) {
			const bridge = getNativeBridge();
			void bridge
				?.getConnectionStatus()
				.then((status) => {
					if (active) setNativeStatus(status);
				})
				.catch(() => {
					if (active) setNativeStatus(EMPTY_NATIVE_STATUS);
				});
		}
		return () => {
			active = false;
			unsubscribe();
		};
	}, [native, initialNativeStatus]);

	if (native) {
		if (nativeStatus === null) {
			return (
				<div className="m-app">
					<PageFallback />
					<DialogHost />
					<ToastHost />
				</div>
			);
		}
		if (nativeStatus.pinMismatch) {
			return (
				<div className="m-app">
					<NativePinMismatchScreen mismatch={nativeStatus.pinMismatch} />
					<DialogHost />
					<ToastHost />
				</div>
			);
		}
		if (!nativeStatus.paired) {
			return (
				<div className="m-app">
					<NativeUnpairedScreen />
					<DialogHost />
					<ToastHost />
				</div>
			);
		}
	}

	return (
		<div className="m-app">
			<ConnectionBanner />
			{paired && <PairingNotice />}
			<main className="m-page">
				<RouteView />
			</main>
			<DialogHost />
			<ToastHost />
			<ImageViewerHost />
		</div>
	);
}
