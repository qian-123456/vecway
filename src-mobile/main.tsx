import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { initNav } from "./core/nav";
import {
	EMPTY_NATIVE_STATUS,
	getNativeBridge,
	subscribeNativeConnectionStatus,
	type NativeEndpointStatus,
} from "./core/nativeBridge";
import { pairWithCode, takePairCode } from "./core/pair";
import { reconnectEvents, startEvents, stopEvents } from "./core/sse";
import { isUnauthorized, useConnection } from "./core/stores/connection";
import { useSessions } from "./core/stores/sessions";
import { startDisplayPrefs } from "./features/settings/displayPrefs";
import "./styles/base.css";

/** Boot order matters: a `?pair=<code>` must be redeemed before the first authenticated call. */
async function boot() {
	const bridge = getNativeBridge();
	if (bridge) {
		let status: NativeEndpointStatus = EMPTY_NATIVE_STATUS;
		try {
			status = await bridge.getConnectionStatus();
		} catch {
			/* keep unpaired fallback so boot does not trigger 401 loops */
		}
		initNav();
		startDisplayPrefs();
		let active = status.paired && !status.pinMismatch;
		if (active) {
			startEvents();
			void useSessions.getState().refresh().catch(() => {});
		}
		subscribeNativeConnectionStatus((next) => {
			const nextActive = next.paired && !next.pinMismatch;
			const wasActive = active;
			active = nextActive;
			if (!nextActive) {
				stopEvents();
				if (!next.paired) useConnection.getState().reset();
			} else if (!wasActive || isUnauthorized()) {
				useConnection.getState().reset();
				startEvents();
				void useSessions.getState().refresh().catch(() => {});
			}
		});
		bridge.onForegroundResync?.(() => {
			if (!active || isUnauthorized()) return;
			reconnectEvents();
			void useSessions.getState().refresh().catch(() => {});
		});
		createRoot(document.getElementById("root")!).render(
			<StrictMode>
				<App nativeStatus={status} />
			</StrictMode>,
		);
		return;
	}

	const code = takePairCode();
	const paired = code ? await pairWithCode(code) : false;
	initNav();
	startEvents();
	startDisplayPrefs();
	void useSessions.getState().refresh().catch(() => {});
	createRoot(document.getElementById("root")!).render(
		<StrictMode>
			<App paired={paired} />
		</StrictMode>,
	);
}

void boot();
