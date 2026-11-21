import { Check, Copy, QrCode, RefreshCw, Unlink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../../core/api";
import { copyText } from "../../../core/lib/format";
import {
	EMPTY_NATIVE_STATUS,
	NATIVE_CHANNEL_LABEL,
	getNativeBridge,
	isNativeApp,
	nativeHaptic,
	notifyNativeConnectionStatus,
	subscribeNativeConnectionStatus,
	validateHttpsEndpoint,
	type NativeEndpointStatus,
} from "../../../core/nativeBridge";
import { reconnectEvents, stopEvents } from "../../../core/sse";
import { useConnection } from "../../../core/stores/connection";
import { useSessions } from "../../../core/stores/sessions";
import { Button, Chip, IconButton, ListGroup, ListRow, confirm, toast } from "../../../ui";
import { GroupBlock, SettingsSheet } from "../rows";

/** `GET /left/settings` → `mobile`: state of the phone service on the desktop. */
export interface MobileInfo {
	running?: boolean;
	port?: number | null;
	lanUrl?: string | null;
	tunnelUrl?: string | null;
	ipv6Running?: boolean;
	ipv6Url?: string | null;
	lanTlsRunning?: boolean;
	lanTlsPort?: number | null;
	lanTlsUrl?: string | null;
	certSha256?: string | null;
}

function UrlRow({ label, url, small = false }: { label: string; url: string; small?: boolean }) {
	const [copied, setCopied] = useState(false);
	const onCopy = async () => {
		if (await copyText(url)) {
			setCopied(true);
			toast("已复制", { kind: "success" });
			setTimeout(() => setCopied(false), 2000);
		} else {
			toast("复制失败，请长按地址手动复制", { kind: "error" });
		}
	};
	return (
		<ListRow
			title={label}
			subtitle={<span className={`m-selectable font-m-mono break-all text-m-text-2 ${small ? "text-m-xs" : ""}`}>{url}</span>}
			right={
				<IconButton
					variant="plain"
					icon={copied ? <Check size={20} className="text-m-success" /> : <Copy size={20} strokeWidth={1.75} />}
					label={`复制${label}`}
					onClick={() => void onCopy()}
				/>
			}
		/>
	);
}

function stripTrailingSlash(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

export function ConnectionSheet({
	open,
	onClose,
	mobile = {},
	appVersion,
}: {
	open: boolean;
	onClose: () => void;
	mobile?: MobileInfo;
	appVersion?: string | null;
}) {
	const native = isNativeApp();
	const [name, setName] = useState("");
	const [saving, setSaving] = useState(false);
	const [nameError, setNameError] = useState<string | null>(null);

	const [nativeStatus, setNativeStatus] = useState<NativeEndpointStatus | null>(null);
	const [lanTlsInput, setLanTlsInput] = useState("");
	const [ipv6Input, setIpv6Input] = useState("");
	const [tunnelInput, setTunnelInput] = useState("");
	const [endpointError, setEndpointError] = useState<string | null>(null);
	const [probing, setProbing] = useState(false);
	const [scanning, setScanning] = useState(false);
	const [updatingEndpoints, setUpdatingEndpoints] = useState(false);
	const [unpairing, setUnpairing] = useState(false);

	const syncCandidateInputs = useCallback((status: NativeEndpointStatus) => {
		setLanTlsInput(status.candidates.lanTls ?? "");
		setIpv6Input(status.candidates.ipv6 ?? "");
		setTunnelInput(status.candidates.tunnel ?? "");
	}, []);

	useEffect(() => {
		if (!open || !native) return;
		const bridge = getNativeBridge();
		if (!bridge) return;
		let active = true;
		void bridge
			.getConnectionStatus()
			.then((status) => {
				if (!active) return;
				setNativeStatus(status);
				syncCandidateInputs(status);
			})
			.catch(() => {});
		const unsubscribe = subscribeNativeConnectionStatus((status) => {
			if (!active) return;
			setNativeStatus(status);
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [open, native, syncCandidateInputs]);

	const saveName = async () => {
		if (saving) return;
		setSaving(true);
		setNameError(null);
		try {
			await api("POST", "/device/name", { name: name.trim() });
			toast("设备名称已保存", { kind: "success" });
		} catch (e) {
			setNameError(errorMessage(e, "保存失败"));
		} finally {
			setSaving(false);
		}
	};

	const handleReprobe = async () => {
		const bridge = getNativeBridge();
		if (!bridge || probing) return;
		setProbing(true);
		try {
			const next = await bridge.reprobeConnection();
			setNativeStatus(next);
			syncCandidateInputs(next);
			notifyNativeConnectionStatus(next);
			if (next.paired && !next.pinMismatch) reconnectEvents();
			toast(next.activeChannel ? `已连接：${NATIVE_CHANNEL_LABEL[next.activeChannel]}` : "未探测到可用通道", {
				kind: next.activeChannel ? "success" : "info",
			});
		} catch (e) {
			toast(`重新探测失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setProbing(false);
		}
	};

	const handleRepair = async () => {
		const bridge = getNativeBridge();
		if (!bridge || scanning) return;
		setScanning(true);
		try {
			const res = await bridge.openPairScanner();
			if (res.ok) {
				const next = res.status ?? (await bridge.getConnectionStatus());
				setNativeStatus(next);
				syncCandidateInputs(next);
				useConnection.getState().reset();
				notifyNativeConnectionStatus(next);
				if (next.paired && !next.pinMismatch) {
					reconnectEvents();
					void useSessions.getState().refresh().catch(() => {});
				}
				nativeHaptic("success");
				toast("重新配对成功", { kind: "success" });
			} else if (res.error) {
				toast(res.error, { kind: "error" });
			}
		} catch (e) {
			toast(`重新扫码配对失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setScanning(false);
		}
	};

	const handleSaveEndpoints = async () => {
		const bridge = getNativeBridge();
		if (!bridge || updatingEndpoints) return;
		setEndpointError(null);
		const lanTls = stripTrailingSlash(lanTlsInput);
		const ipv6 = stripTrailingSlash(ipv6Input);
		const tunnel = stripTrailingSlash(tunnelInput);
		const err =
			validateHttpsEndpoint(lanTls, "局域网 TLS 地址") ||
			validateHttpsEndpoint(ipv6, "IPv6 TLS 地址") ||
			validateHttpsEndpoint(tunnel, "Cloudflare 隧道地址");
		if (err) {
			setEndpointError(err);
			return;
		}
		if (!lanTls && !ipv6 && !tunnel) {
			setEndpointError("请至少填写一个 https:// 连接地址");
			return;
		}
		const patch: Partial<NativeEndpointStatus["candidates"]> = {};
		if (lanTls) patch.lanTls = lanTls;
		else if (nativeStatus?.candidates.lanTls) patch.lanTls = "";
		if (ipv6) patch.ipv6 = ipv6;
		else if (nativeStatus?.candidates.ipv6) patch.ipv6 = "";
		if (tunnel) patch.tunnel = tunnel;
		else if (nativeStatus?.candidates.tunnel) patch.tunnel = "";
		setUpdatingEndpoints(true);
		try {
			const next = await bridge.updateEndpoints(patch);
			setNativeStatus(next);
			syncCandidateInputs(next);
			notifyNativeConnectionStatus(next);
			if (next.paired && !next.pinMismatch) reconnectEvents();
			toast("连接地址已更新", { kind: "success" });
		} catch (e) {
			const msg = errorMessage(e, "更新端点失败");
			setEndpointError(msg);
			toast(msg, { kind: "error" });
		} finally {
			setUpdatingEndpoints(false);
		}
	};

	const handleUnpair = async () => {
		const bridge = getNativeBridge();
		if (!bridge || unpairing) return;
		const ok = await confirm({
			title: "解除配对",
			message: "解除后将清除本机保存的配对令牌与证书指纹，需要重新扫码配对才能连接电脑。",
			confirmText: "解除配对",
			danger: true,
		});
		if (!ok) return;
		setUnpairing(true);
		try {
			await bridge.unpair();
			stopEvents();
			useConnection.getState().reset();
			notifyNativeConnectionStatus(EMPTY_NATIVE_STATUS);
			onClose();
			toast("已解除配对");
		} catch (e) {
			toast(`解除配对失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setUnpairing(false);
		}
	};

	const here = typeof location === "undefined" ? "" : location.origin;
	const channelLabel = nativeStatus?.activeChannel ? NATIVE_CHANNEL_LABEL[nativeStatus.activeChannel] : "未连接";

	return (
		<SettingsSheet open={open} onClose={onClose} title="连接与设备">
			<ListGroup title="当前设备" note="名称仅用于区分配对记录，不影响连接。留空可使用默认名称。">
				<GroupBlock>
					<form onSubmit={(event) => { event.preventDefault(); void saveName(); }} className="flex flex-col gap-3">
						<label htmlFor="device-name" className="text-m-sm text-m-text">设备名称（可选）</label>
						<input id="device-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="使用默认名称" className="w-full rounded-m-md bg-m-surface px-3 py-2 text-m-md text-m-text" />
						{nameError && <p role="alert" className="text-m-sm break-words text-m-danger">{nameError}</p>}
						<Button type="submit" disabled={saving}>{saving ? "保存中…" : "保存名称"}</Button>
					</form>
				</GroupBlock>
			</ListGroup>
			{native ? (
				<>
					<ListGroup title="加密连接" note="App 仅通过 TLS 加密通道连接桌面端，并校验锁定证书指纹。">
						<ListRow
							title="当前通道"
							right={<Chip tone={nativeStatus?.activeChannel ? "success" : "warn"}>{channelLabel}</Chip>}
						/>
						{nativeStatus?.activeUrl && <UrlRow label="当前连接地址" url={nativeStatus.activeUrl} />}
						{nativeStatus?.certSha256 && <UrlRow label="锁定证书指纹 (SHA-256)" url={nativeStatus.certSha256} small />}
						{nativeStatus?.pinMismatch && (
							<GroupBlock>
								<div role="alert" className="space-y-1 rounded-m-md bg-m-danger-bg p-3 text-m-xs text-m-danger">
									<div className="font-medium">证书指纹不匹配（已阻断连接）</div>
									<div className="m-selectable font-m-mono break-all">锁定：{nativeStatus.pinMismatch.expectedSha256}</div>
									<div className="m-selectable font-m-mono break-all">实际：{nativeStatus.pinMismatch.actualSha256}</div>
								</div>
							</GroupBlock>
						)}
						<GroupBlock className="flex flex-wrap gap-2">
							<Button variant="tonal" size="sm" icon={<RefreshCw size={16} />} busy={probing} onClick={() => void handleReprobe()}>
								重新探测连接
							</Button>
							<Button variant="accent" size="sm" icon={<QrCode size={16} />} busy={scanning} onClick={() => void handleRepair()}>
								重新扫码配对
							</Button>
						</GroupBlock>
					</ListGroup>
					<ListGroup title="手动更新端点" note="仅允许 https:// 加密地址，禁止降级为明文 http://。">
						<GroupBlock>
							<form
								noValidate
								onSubmit={(event) => {
									event.preventDefault();
									void handleSaveEndpoints();
								}}
								className="flex flex-col gap-3"
							>
								<div className="flex flex-col gap-1">
									<label htmlFor="endpoint-lan-tls" className="text-m-sm text-m-text">局域网 TLS 地址</label>
									<input
										id="endpoint-lan-tls"
										type="url"
										inputMode="url"
										value={lanTlsInput}
										onChange={(event) => setLanTlsInput(event.target.value)}
										placeholder="https://192.168.1.10:7790"
										className="w-full rounded-m-md bg-m-surface px-3 py-2 font-m-mono text-m-sm text-m-text"
									/>
								</div>
								<div className="flex flex-col gap-1">
									<label htmlFor="endpoint-ipv6" className="text-m-sm text-m-text">IPv6 TLS 地址</label>
									<input
										id="endpoint-ipv6"
										type="url"
										inputMode="url"
										value={ipv6Input}
										onChange={(event) => setIpv6Input(event.target.value)}
										placeholder="https://example.com:7789"
										className="w-full rounded-m-md bg-m-surface px-3 py-2 font-m-mono text-m-sm text-m-text"
									/>
								</div>
								<div className="flex flex-col gap-1">
									<label htmlFor="endpoint-tunnel" className="text-m-sm text-m-text">Cloudflare 隧道地址</label>
									<input
										id="endpoint-tunnel"
										type="url"
										inputMode="url"
										value={tunnelInput}
										onChange={(event) => setTunnelInput(event.target.value)}
										placeholder="https://xxx.trycloudflare.com"
										className="w-full rounded-m-md bg-m-surface px-3 py-2 font-m-mono text-m-sm text-m-text"
									/>
								</div>
								{endpointError && (
									<p role="alert" className="text-m-sm break-words text-m-danger">
										{endpointError}
									</p>
								)}
								<Button type="submit" busy={updatingEndpoints}>
									保存端点
								</Button>
							</form>
						</GroupBlock>
					</ListGroup>
					{(mobile.running !== undefined || mobile.lanTlsPort != null || appVersion) && (
						<ListGroup title="桌面端服务">
							{mobile.running !== undefined && (
								<ListRow title="服务状态" right={<Chip tone={mobile.running ? "success" : "warn"}>{mobile.running ? "运行中" : "未运行"}</Chip>} />
							)}
							{mobile.lanTlsPort != null && <ListRow title="局域网 TLS 端口" right={<span className="font-m-mono">{mobile.lanTlsPort}</span>} />}
							{appVersion && <ListRow title="电脑端版本" right={<span className="font-m-mono">{appVersion}</span>} />}
						</ListGroup>
					)}
					<ListGroup title="设备配对">
						<GroupBlock>
							<Button variant="danger" block icon={<Unlink size={16} />} busy={unpairing} onClick={() => void handleUnpair()}>
								解除配对
							</Button>
						</GroupBlock>
					</ListGroup>
				</>
			) : (
				<>
					<ListGroup title="手机服务">
						<ListRow title="服务状态" right={<Chip tone={mobile.running ? "success" : "warn"}>{mobile.running ? "运行中" : "未运行"}</Chip>} />
						{mobile.port != null && <ListRow title="端口" right={<span className="font-m-mono">{mobile.port}</span>} />}
						{appVersion && <ListRow title="电脑端版本" right={<span className="font-m-mono">{appVersion}</span>} />}
					</ListGroup>
					<ListGroup title="访问地址" note="把地址发到其他设备上的浏览器即可访问；首次打开需要在电脑上确认配对。">
						{here && <UrlRow label="当前地址" url={here} />}
						{mobile.lanUrl && <UrlRow label="局域网地址" url={mobile.lanUrl} />}
						{mobile.lanTlsRunning && mobile.lanTlsUrl && <UrlRow label="局域网 TLS 地址" url={mobile.lanTlsUrl} />}
						{mobile.tunnelUrl && <UrlRow label="隧道地址" url={mobile.tunnelUrl} />}
						{mobile.ipv6Running && mobile.ipv6Url && <UrlRow label="IPv6 地址" url={mobile.ipv6Url} />}
					</ListGroup>
					<p className="px-8 pt-2 text-m-xs break-words text-m-text-3">
						开关手机服务、切换端口和 IPv6 需要在电脑上操作：在手机上关闭会立刻断开当前连接，且无法再从手机重新打开。
					</p>
				</>
			)}
		</SettingsSheet>
	);
}
