import { getNativeBridge } from "../core/nativeBridge";

/**
 * Single source of truth for viewport and on-screen keyboard state.
 *
 * - Native iOS / Android shell: driven directly by `bridge.onKeyboardChange` (`height`, `durationMs`),
 *   writing `--m-kb`, `--m-kb-dur`, `--m-vh` (`calc(100dvh - <kb>px)`), `--m-vv-top: 0px`, and
 *   `data-kb-open` without fighting `visualViewport.offsetTop`.
 * - Web browsers: rAF-coalesced `visualViewport` resize/scroll fallback (never bare input focus).
 */
let kbOpen = false;
const kbListeners = new Set<(open: boolean) => void>();

function setKeyboardOpen(next: boolean, root?: HTMLElement): void {
	if (root) root.dataset.kbOpen = next ? "1" : "0";
	if (next === kbOpen) return;
	kbOpen = next;
	for (const cb of [...kbListeners]) cb(kbOpen);
}

export function isKeyboardOpenNow(): boolean {
	return kbOpen;
}

export function subscribeKeyboardOpen(cb: (open: boolean) => void): () => void {
	kbListeners.add(cb);
	return () => {
		kbListeners.delete(cb);
	};
}

export function installViewportTracking(): () => void {
	const root = document.documentElement;
	const bridge = getNativeBridge();

	if (bridge?.onKeyboardChange) {
		let lastKb = -1;
		let lastDur = -1;
		root.dataset.kbNative = "1";
		root.style.setProperty("--m-vv-top", "0px");

		const applyNative = (height: number, durationMs: number) => {
			const kb = Math.max(0, Math.round(height));
			const dur = Math.max(0, Math.round(durationMs));
			if (dur !== lastDur) {
				root.style.setProperty("--m-kb-dur", `${dur}ms`);
				lastDur = dur;
			}
			if (kb !== lastKb) {
				root.style.setProperty("--m-kb", `${kb}px`);
				root.style.setProperty("--m-vh", `calc(100dvh - ${kb}px)`);
				lastKb = kb;
			}
			setKeyboardOpen(kb > 40, root);
		};

		applyNative(0, 0);
		const unsub = bridge.onKeyboardChange(({ height, durationMs }) => {
			applyNative(height, durationMs);
		});

		return () => {
			unsub();
			setKeyboardOpen(false);
			delete root.dataset.kbNative;
			delete root.dataset.kbOpen;
			root.style.removeProperty("--m-vh");
			root.style.removeProperty("--m-kb");
			root.style.removeProperty("--m-kb-dur");
			root.style.removeProperty("--m-vv-top");
		};
	}

	const vv = window.visualViewport;
	if (!vv) {
		setKeyboardOpen(false, root);
		return () => {
			delete root.dataset.kbOpen;
		};
	}

	let raf = 0;
	let lastH = -1;
	let lastKb = -1;
	let lastTop = -1;

	const apply = () => {
		raf = 0;
		const h = Math.round(vv.height);
		const top = Math.round(vv.offsetTop);
		const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
		if (h !== lastH) {
			root.style.setProperty("--m-vh", `${h}px`);
			lastH = h;
		}
		if (kb !== lastKb) {
			root.style.setProperty("--m-kb", `${kb}px`);
			lastKb = kb;
		}
		if (top !== lastTop) {
			root.style.setProperty("--m-vv-top", `${top}px`);
			lastTop = top;
		}
		setKeyboardOpen(kb > 80, root);
	};
	const schedule = () => {
		if (!raf) raf = requestAnimationFrame(apply);
	};
	root.style.setProperty("--m-kb-dur", "0ms");
	vv.addEventListener("resize", schedule);
	vv.addEventListener("scroll", schedule);
	apply();
	return () => {
		vv.removeEventListener("resize", schedule);
		vv.removeEventListener("scroll", schedule);
		if (raf) cancelAnimationFrame(raf);
		setKeyboardOpen(false);
		delete root.dataset.kbOpen;
		root.style.removeProperty("--m-vh");
		root.style.removeProperty("--m-kb");
		root.style.removeProperty("--m-kb-dur");
		root.style.removeProperty("--m-vv-top");
	};
}
