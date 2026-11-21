import { Check, Copy, QrCode, RefreshCw, ShieldCheck, Unlink, Wifi } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../../core/api";
import { copyText } from "../../../core/lib/format";
import {
	EMPTY_NATIVE_STATUS,
	NATIVE_CHANNEL_LABEL,
	getNativeBridge,
	isNativeApp,
	nativeHaptic,
	normalizeHttpsEndpointInput,
	notifyNativeConnectionStatus,
	subscribeNativeConnectionStatus,
	validateHttpsEndpoint,
	type NativeChannel,
	type NativeEndpointStatus,
} from "../../../core/nativeBridge";
import { reconnectEvents, stopEvents } from "../../../core/sse";
import { useConnection } from "../../../core/stores/connection";
import { useSessions } from "../../../core/stores/sessions";
import { Button, Chip, IconButton, ListGroup, ListRow, confirm, toast } from "../../../ui";
import { GroupBlock, SettingsSheet } from "../rows";

type ChannelChoice = "auto" | NativeChannel;

function validateCertSha256(raw: string): string | null {
	const cleaned = raw.trim().replace(/:/g, "");
	if (!cleaned) return null;
	if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
		return "证书指纹格式无效，请输入 64 位 SHA-256 十六进制字符串";
	}
	return null;
}

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
	const [discoveredMobile, setDiscoveredMobile] = useState<MobileInfo | null>(null);
	const [lanTlsInput, setLanTlsInput] = useState("");
	const [ipv6Input, setIpv6Input] = useState("");
	const [tunnelInput, setTunnelInput] = useState("");
	const [certSha256Input, setCertSha256Input] = useState("");
	const [endpointError, setEndpointError] = useState<string | null>(null);
	const [switchingChannel, setSwitchingChannel] = useState(false);
	const [adoptingLan, setAdoptingLan] = useState(false);
	const [probing, setProbing] = useState(false);
	const [scanning, setScanning] = useState(false);
	const [updatingEndpoints, setUpdatingEndpoints] = useState(false);
	const [unpairing, setUnpairing] = useState(false);

	const effectiveMobile: MobileInfo = { ...discoveredMobile, ...mobile };

	const syncCandidateInputs = useCallback((status: NativeEndpointStatus) => {
		setLanTlsInput(status.candidates.lanTls ?? "");
		setIpv6Input(status.candidates.ipv6 ?? "");
		setTunnelInput(status.candidates.tunnel ?? "");
		if (status.certSha256) setCertSha256Input("");
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

	// When domain-paired without a pinned LAN cert, auto-discover desktop LAN TLS info over the authenticated tunnel.
	useEffect(() => {
		if (!open || !native || !nativeStatus?.paired || nativeStatus.certSha256) return;
		if (mobile.lanTlsUrl && mobile.certSha256) return;
		let active = true;
		void api<{ mobile?: MobileInfo }>("GET", "/left/settings")
			.then((res) => {
				if (active && res && typeof res === "object" && res.mobile) {
					setDiscoveredMobile(res.mobile);
				}
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [open, native, nativeStatus?.paired, nativeStatus?.certSha256, mobile.lanTlsUrl, mobile.certSha256]);

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

	const handleSwitchChannel = async (mode: ChannelChoice) => {
		const bridge = getNativeBridge();
		if (!bridge || switchingChannel) return;
		if (!bridge.switchChannel) {
			toast("当前客户端版本暂不支持手动切换通道", { kind: "info" });
			return;
		}
		const target: NativeChannel | null = mode === "auto" ? null : mode;
		setSwitchingChannel(true);
		try {
			const next = await bridge.switchChannel(target);
			setNativeStatus(next);
			syncCandidateInputs(next);
			notifyNativeConnectionStatus(next);
			if (next.paired && !next.pinMismatch) reconnectEvents();
			const reached = target === null ? Boolean(next.activeChannel) : next.activeChannel === target;
			nativeHaptic(reached ? "success" : "warning");
			if (target === null) {
				toast(
					next.activeChannel
						? `已切换为自动优选（当前：${NATIVE_CHANNEL_LABEL[next.activeChannel]}）`
						: "已切换为自动优选，暂未探测到可用通道",
					{ kind: next.activeChannel ? "success" : "info" },
				);
			} else if (next.activeChannel === target) {
				toast(`已切换至${NATIVE_CHANNEL_LABEL[target]}`, { kind: "success" });
			} else {
				toast(
					next.activeChannel
						? `无法连接${NATIVE_CHANNEL_LABEL[target]}，当前仍使用${NATIVE_CHANNEL_LABEL[next.activeChannel]}`
						: `无法连接${NATIVE_CHANNEL_LABEL[target]}，请检查网络环境`,
					{ kind: "info" },
				);
			}
		} catch (e) {
			nativeHaptic("error");
			toast(`切换通道失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setSwitchingChannel(false);
		}
	};

	const handleAdoptLan = async () => {
		const bridge = getNativeBridge();
		const lanTls = effectiveMobile.lanTlsUrl?.trim();
		const certSha256 = effectiveMobile.certSha256?.trim();
		if (!bridge || !lanTls || !certSha256 || adoptingLan) return;
		setAdoptingLan(true);
		setEndpointError(null);
		try {
			let next = await bridge.updateEndpoints({ lanTls, certSha256 });
			if (bridge.switchChannel && next.activeChannel !== "lan_tls") {
				try {
					next = await bridge.switchChannel("lan_tls");
				} catch {
					// Endpoint + fingerprint are already persisted; LAN is just unreachable on the current network.
				}
			}
			setNativeStatus(next);
			syncCandidateInputs(next);
			notifyNativeConnectionStatus(next);
			if (next.paired && !next.pinMismatch) reconnectEvents();
			nativeHaptic(next.activeChannel === "lan_tls" ? "success" : "warning");
			toast(
				next.activeChannel === "lan_tls"
					? "已信任并切换至局域网直连"
					: "已保存局域网加密配置，连入电脑同 Wi-Fi 后即可直连",
				{ kind: next.activeChannel === "lan_tls" ? "success" : "info" },
			);
		} catch (e) {
			nativeHaptic("error");
			const msg = errorMessage(e, "启用局域网直连失败");
			setEndpointError(msg);
			toast(msg, { kind: "error" });
		} finally {
			setAdoptingLan(false);
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
		const lanTls = normalizeHttpsEndpointInput(lanTlsInput);
		const ipv6 = normalizeHttpsEndpointInput(ipv6Input);
		const tunnel = normalizeHttpsEndpointInput(tunnelInput);
		const certSha256 = certSha256Input.trim();
		const err =
			validateHttpsEndpoint(lanTls, "局域网 TLS 地址") ||
			validateHttpsEndpoint(ipv6, "IPv6 TLS 地址") ||
			validateHttpsEndpoint(tunnel, "Cloudflare / 公网域名地址") ||
			(!nativeStatus?.certSha256 ? validateCertSha256(certSha256) : null);
		if (err) {
			setEndpointError(err);
			return;
		}
		if (!lanTls && !ipv6 && !tunnel) {
			setEndpointError("请至少填写一个 https:// 连接地址");
			return;
		}
		if (!nativeStatus?.certSha256 && (lanTls || ipv6) && !certSha256) {
			setEndpointError("首次添加局域网或 IPv6 TLS 地址时，请同时填写证书指纹，或直接点击上方一键启用局域网直连");
			return;
		}
		const patch: Partial<NativeEndpointStatus["candidates"]> & { certSha256?: string } = {};
		if (lanTls) patch.lanTls = lanTls;
		else if (nativeStatus?.candidates.lanTls) patch.lanTls = "";
		if (ipv6) patch.ipv6 = ipv6;
		else if (nativeStatus?.candidates.ipv6) patch.ipv6 = "";
		if (tunnel) patch.tunnel = tunnel;
		else if (nativeStatus?.candidates.tunnel) patch.tunnel = "";
		if (!nativeStatus?.certSha256 && certSha256) {
			patch.certSha256 = certSha256;
		}
		setUpdatingEndpoints(true);
		try {
			const next = await bridge.updateEndpoints(patch);
			setNativeStatus(next);
			syncCandidateInputs(next);
			notifyNativeConnectionStatus(next);
			if (next.paired && !next.pinMismatch) reconnectEvents();
			toast(
				next.activeChannel ? `已保存并连接：${NATIVE_CHANNEL_LABEL[next.activeChannel]}` : "地址已保存，但暂未探测到可用连接",
				{ kind: next.activeChannel ? "success" : "info" },
			);
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
	const preferredMode: ChannelChoice = nativeStatus?.preferredChannel ?? "auto";
	const hasLanCandidate = Boolean(nativeStatus?.candidates.lanTls && nativeStatus?.certSha256);
	const hasTunnelCandidate = Boolean(nativeStatus?.candidates.tunnel);
	const showIpv6Choice = Boolean(
		nativeStatus?.candidates.ipv6 ||
			nativeStatus?.activeChannel === "ipv6_tls" ||
			nativeStatus?.preferredChannel === "ipv6_tls",
	);
	const canAdoptLan = Boolean(
		nativeStatus?.paired &&
			!nativeStatus.certSha256 &&
			effectiveMobile.lanTlsUrl &&
			effectiveMobile.certSha256,
	);

	const channelOptions: ReadonlyArray<{ value: ChannelChoice; label: string; disabled?: boolean }> = [
		{ value: "auto", label: "自动优选" },
		{ value: "lan_tls", label: "局域网直连", disabled: !hasLanCandidate },
		{ value: "tunnel", label: "公网域名", disabled: !hasTunnelCandidate },
		...(showIpv6Choice
			? [{ value: "ipv6_tls" as const, label: "IPv6", disabled: !nativeStatus?.candidates.ipv6 || !nativeStatus?.certSha256 }]
			: []),
	];

	return (
		<SettingsSheet open={open} onClose={onClose} title="连接与设备">
			{native ? (
				<>
					<ListGroup
						title="连接方式"
						note="回家后可直接切换「局域网直连」或保持「自动优选」（优先局域网），外出自动走公网域名，无需重新扫码。"
					>
						<ListRow
							title="当前通道"
							right={<Chip tone={nativeStatus?.activeChannel ? "success" : "warn"}>{channelLabel}</Chip>}
						/>
						{nativeStatus?.paired && (
							<GroupBlock className="space-y-3">
								<div
									role="radiogroup"
									aria-label="连接方式"
									className="flex flex-wrap gap-1.5 rounded-m-md bg-m-surface p-1"
								>
									{channelOptions.map((opt) => {
										const selected = preferredMode === opt.value;
										return (
											<button
												key={opt.value}
												type="button"
												role="radio"
												aria-checked={selected}
												disabled={switchingChannel || (opt.disabled && !selected)}
												onClick={() => void handleSwitchChannel(opt.value)}
												className={`min-h-10 min-w-[72px] flex-1 rounded-m-sm px-2.5 text-m-xs whitespace-nowrap transition-colors duration-(--m-dur-fast) disabled:opacity-40 ${
													selected
														? "bg-m-segment-on font-semibold text-m-text shadow-xs"
														: "text-m-text-2 active:bg-m-surface-hover"
												}`}
											>
												{opt.label}
											</button>
										);
									})}
								</div>

								{canAdoptLan && effectiveMobile.lanTlsUrl && effectiveMobile.certSha256 && (
									<div className="space-y-2.5 rounded-m-md border border-m-border bg-m-accent-soft/45 p-3.5">
										<div className="flex items-start gap-2.5">
											<Wifi size={18} strokeWidth={1.85} className="mt-0.5 shrink-0 text-m-accent" aria-hidden />
											<div className="min-w-0 flex-1 space-y-1">
												<div className="text-m-sm font-medium text-m-text">检测到电脑局域网加密服务</div>
												<div className="m-selectable break-all font-m-mono text-m-xs text-m-text-2">
													{effectiveMobile.lanTlsUrl}
												</div>
												<div className="space-y-0.5 text-[11px] text-m-text-3">
													<div className="flex items-center gap-1.5">
														<ShieldCheck size={13} className="shrink-0" aria-hidden />
														<span>证书指纹 (SHA-256)</span>
													</div>
													<div className="m-selectable break-all font-m-mono leading-relaxed text-m-text-2">
														{effectiveMobile.certSha256}
													</div>
												</div>
											</div>
										</div>
										<Button
											variant="primary"
											size="sm"
											block
											busy={adoptingLan}
											onClick={() => void handleAdoptLan()}
										>
											信任并切换至局域网直连
										</Button>
									</div>
								)}
							</GroupBlock>
						)}
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
					<ListGroup title="手动更新端点" note="支持直接填写域名（自动补全 https://），禁止降级为明文 http://。">
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
									<label htmlFor="endpoint-tunnel" className="text-m-sm text-m-text">Cloudflare / 公网域名地址</label>
									<input
										id="endpoint-tunnel"
										type="url"
										inputMode="url"
										value={tunnelInput}
										onChange={(event) => setTunnelInput(event.target.value)}
										placeholder="https://omp.example.com 或 xxx.trycloudflare.com"
										className="w-full rounded-m-md bg-m-surface px-3 py-2 font-m-mono text-m-sm text-m-text"
									/>
									<p className="text-m-xs text-m-text-3">适用于 Cloudflare Tunnel 域名或有效 HTTPS 反代域名，走系统根证书校验。</p>
								</div>
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
									<p className="text-m-xs text-m-text-3">与电脑同一 Wi-Fi 下直连桌面端 TLS 端口，延迟最低。</p>
								</div>
								<div className="flex flex-col gap-1">
									<label htmlFor="endpoint-ipv6" className="text-m-sm text-m-text">IPv6 TLS 地址</label>
									<input
										id="endpoint-ipv6"
										type="url"
										inputMode="url"
										value={ipv6Input}
										onChange={(event) => setIpv6Input(event.target.value)}
										placeholder="https://[240e:...]:7789 或 DDNS 域名:7789"
										className="w-full rounded-m-md bg-m-surface px-3 py-2 font-m-mono text-m-sm text-m-text"
									/>
									<p className="text-m-xs text-m-text-3">仅用于电脑 IPv6 / Cloudflare DDNS 端口直连（校验证书指纹）；Cloudflare Tunnel 域名请填在上方。</p>
								</div>
								{!nativeStatus?.certSha256 && (
									<div className="flex flex-col gap-1">
										<label htmlFor="endpoint-cert-sha256" className="text-m-sm text-m-text">局域网证书指纹 (SHA-256，可选)</label>
										<input
											id="endpoint-cert-sha256"
											type="text"
											autoCapitalize="off"
											autoCorrect="off"
											spellCheck={false}
											value={certSha256Input}
											onChange={(event) => setCertSha256Input(event.target.value)}
											placeholder="AA:BB:CC:...（首次启用局域网/IPv6 时填写）"
											className="w-full rounded-m-md bg-m-surface px-3 py-2 font-m-mono text-m-xs text-m-text"
										/>
										<p className="text-m-xs text-m-text-3">仅首次添加局域网或 IPv6 直连时需要锁定证书指纹，锁定后不会静默覆盖。</p>
									</div>
								)}
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
					{(effectiveMobile.running !== undefined || effectiveMobile.lanTlsPort != null || appVersion) && (
						<ListGroup title="桌面端服务">
							{effectiveMobile.running !== undefined && (
								<ListRow title="服务状态" right={<Chip tone={effectiveMobile.running ? "success" : "warn"}>{effectiveMobile.running ? "运行中" : "未运行"}</Chip>} />
							)}
							{effectiveMobile.lanTlsPort != null && <ListRow title="局域网 TLS 端口" right={<span className="font-m-mono">{effectiveMobile.lanTlsPort}</span>} />}
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
					<ListGroup title="手机服务">
						<ListRow title="服务状态" right={<Chip tone={effectiveMobile.running ? "success" : "warn"}>{effectiveMobile.running ? "运行中" : "未运行"}</Chip>} />
						{effectiveMobile.port != null && <ListRow title="端口" right={<span className="font-m-mono">{effectiveMobile.port}</span>} />}
						{appVersion && <ListRow title="电脑端版本" right={<span className="font-m-mono">{appVersion}</span>} />}
					</ListGroup>
					<ListGroup title="访问地址" note="把地址发到其他设备上的浏览器即可访问；首次打开需要在电脑上确认配对。">
						{here && <UrlRow label="当前地址" url={here} />}
						{effectiveMobile.lanUrl && <UrlRow label="局域网地址" url={effectiveMobile.lanUrl} />}
						{effectiveMobile.lanTlsRunning && effectiveMobile.lanTlsUrl && <UrlRow label="局域网 TLS 地址" url={effectiveMobile.lanTlsUrl} />}
						{effectiveMobile.tunnelUrl && <UrlRow label="隧道地址" url={effectiveMobile.tunnelUrl} />}
						{effectiveMobile.ipv6Running && effectiveMobile.ipv6Url && <UrlRow label="IPv6 地址" url={effectiveMobile.ipv6Url} />}
					</ListGroup>
					<p className="px-8 pt-2 text-m-xs break-words text-m-text-3">
						开关手机服务、切换端口和 IPv6 需要在电脑上操作：在手机上关闭会立刻断开当前连接，且无法再从手机重新打开。
					</p>
				</>
			)}
		</SettingsSheet>
	);
}
