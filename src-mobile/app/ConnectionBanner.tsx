import { CloudOff, KeyRound } from "lucide-react";
import { useRef, useState, type ReactNode, type Ref } from "react";
import { errorMessage } from "../core/api";
import { getNativeBridge, isNativeApp, nativeHaptic, notifyNativeConnectionStatus } from "../core/nativeBridge";
import { reconnectEvents } from "../core/sse";
import { useConnection } from "../core/stores/connection";
import { useSessions } from "../core/stores/sessions";
import { AnchoredPopover } from "../ui/AnchoredPopover";
import { Spinner } from "../ui/Spinner";
import { toast } from "../ui/Toast";

/** Floating capsule just below the top bar; never covers the bar's buttons. */
function Pill({ role, tone, icon, text, action, onAction, actionRef }: { role: "alert" | "status"; tone: "warn" | "danger"; icon: ReactNode; text: string; action: string; onAction: () => void; actionRef?: Ref<HTMLButtonElement> }) {
	return (
		<div className="pointer-events-none fixed inset-x-0 z-(--z-banner) flex justify-center px-4" style={{ top: "calc(var(--m-safe-top) + 60px)" }}>
			<div
				role={role}
				className={`pointer-events-auto flex max-w-full items-center gap-2 rounded-m-pill py-1 pr-1 pl-4 text-m-sm shadow-m-pop ${
					tone === "danger" ? "bg-m-danger-bg text-m-danger" : "bg-m-warn-bg text-m-warn"
				}`}
			>
				<span className="shrink-0">{icon}</span>
				<span className="min-w-0 break-words">{text}</span>
				<button ref={actionRef} type="button" onClick={onAction} className="min-h-11 min-w-11 shrink-0 rounded-m-pill px-3 font-medium whitespace-nowrap active:bg-m-surface-hover">
					{action}
				</button>
			</div>
		</div>
	);
}

/** Offline / reconnecting / unpaired (401) indicator with a re-pair guide or native scanner trigger. */
export function ConnectionBanner() {
	const phase = useConnection((s) => s.phase);
	const error = useConnection((s) => s.error);
	const [guide, setGuide] = useState(false);
	const [pairing, setPairing] = useState(false);
	const repairBtnRef = useRef<HTMLButtonElement>(null);
	const sawClosed = useRef(false);
	if (phase === "closed") sawClosed.current = true;
	if (phase === "open") sawClosed.current = false;

	const handleNativeRepair = async () => {
		const bridge = getNativeBridge();
		if (!bridge || pairing) return;
		setPairing(true);
		try {
			const res = await bridge.openPairScanner();
			if (res.ok) {
				useConnection.getState().reset();
				if (res.status) notifyNativeConnectionStatus(res.status);
				reconnectEvents();
				void useSessions.getState().refresh().catch(() => {});
				nativeHaptic("success");
				toast("重新配对成功", { kind: "success" });
			} else if (res.error) {
				toast(res.error, { kind: "error" });
			}
		} catch (e) {
			toast(errorMessage(e, "扫码配对失败"), { kind: "error" });
		} finally {
			setPairing(false);
		}
	};

	if (phase === "unauthorized") {
		if (isNativeApp()) {
			return (
				<Pill
					role="alert"
					tone="danger"
					icon={<KeyRound size={16} />}
					text="配对已失效"
					action={pairing ? "配对中" : "重新配对"}
					onAction={() => void handleNativeRepair()}
				/>
			);
		}
		return (
			<>
				<Pill role="alert" tone="danger" icon={<KeyRound size={16} />} text="配对已失效" action="重新配对" onAction={() => setGuide(true)} actionRef={repairBtnRef} />
				<AnchoredPopover
					open={guide}
					onClose={() => setGuide(false)}
					anchorEl={repairBtnRef.current}
					placement="bottom-center"
					title="重新配对"
					maxWidth={320}
					minWidth={240}
				>
					<ol className="m-selectable list-decimal space-y-2.5 px-4 py-3 pl-9 text-m-sm text-m-text-2">
						<li>在电脑上打开 Vecway，进入「设置 → 连接与设备」。</li>
						<li>点击「生成配对二维码」。</li>
						<li>用手机相机扫描二维码，或直接打开配对链接。</li>
						<li>配对成功后这里会自动恢复。</li>
					</ol>
				</AnchoredPopover>
			</>
		);
	}

	const offline = phase === "closed" || (phase === "connecting" && sawClosed.current);
	if (!offline) return null;
	const connecting = phase === "connecting";
	return (
		<Pill
			role="status"
			tone="warn"
			icon={connecting ? <Spinner size={14} /> : <CloudOff size={16} />}
			text={connecting ? "正在重新连接" : error || "连接已断开"}
			action="重试"
			onAction={reconnectEvents}
		/>
	);
}
