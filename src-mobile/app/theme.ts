import { useEffect } from "react";
import { getNativeBridge } from "../core/nativeBridge";
import { resolveScheme, usePrefs, type Scheme, type SchemePref } from "../core/stores/prefs";
import { resolveThemeId } from "./themes";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Write `data-scheme` and `data-theme` on <html> and sync browser and iOS status-bar chrome. */
export function applyTheme(scheme: Scheme, themeId?: string, pref: SchemePref = scheme): void {
	const root = document.documentElement;
	const resolvedTheme = resolveThemeId(scheme, themeId);
	root.dataset.scheme = scheme;
	root.dataset.theme = resolvedTheme;
	let statusBarMeta = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]');
	if (!statusBarMeta) {
		statusBarMeta = document.createElement("meta");
		statusBarMeta.name = "apple-mobile-web-app-status-bar-style";
		document.head.appendChild(statusBarMeta);
	}
	statusBarMeta.content = scheme === "dark" ? "black-translucent" : "default";
	// Theme colour comes from the freshly applied token, so tokens.css stays the single source of truth.
	const bg = getComputedStyle(root).getPropertyValue("--m-bg").trim();
	getNativeBridge()?.setAppearance?.(pref, bg || undefined);
	if (!bg) return;
	let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (!meta) {
		meta = document.createElement("meta");
		meta.name = "theme-color";
		document.head.appendChild(meta);
	}
	meta.content = bg;
}

/** Keeps the document scheme & palette attributes in step with prefs and the system colour scheme. */
export function useTheme(): void {
	const pref = usePrefs((s) => s.scheme);
	const lightTheme = usePrefs((s) => s.lightTheme);
	const darkTheme = usePrefs((s) => s.darkTheme);
	useEffect(() => {
		const mq = window.matchMedia(DARK_QUERY);
		const apply = () => {
			const scheme = resolveScheme(pref, mq.matches);
			applyTheme(scheme, scheme === "dark" ? darkTheme : lightTheme, pref);
		};
		apply();
		if (pref !== "system") return;
		mq.addEventListener("change", apply);
		return () => mq.removeEventListener("change", apply);
	}, [pref, lightTheme, darkTheme]);
}
