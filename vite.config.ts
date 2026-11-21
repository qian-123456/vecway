import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vitest/config";

const KATEX_CSS_RE = /[/\\]katex(?:\.min)?\.css(?:$|\?)/;
const LEGACY_KATEX_FONT_SRC =
	/,\s*url\([^)]*\.(?:woff|ttf)(?:[?#][^)'"]*)?['"]?\)\s*format\(["'](?:woff|truetype)["']\)/gi;

/** Strip legacy .woff/.ttf KaTeX font-face fallbacks; WKWebView 12+ and ES2021 browsers support .woff2. */
function katexWoff2Only(): Plugin {
	return {
		name: "katex-woff2-only",
		enforce: "pre",
		transform(code, id) {
			if (!KATEX_CSS_RE.test(id)) return null;
			const next = code.replace(LEGACY_KATEX_FONT_SRC, "");
			return next === code ? null : { code: next, map: null };
		},
	};
}

// https://vite.dev/config/
export default defineConfig({
	plugins: [katexWoff2Only(), react(), tailwindcss()],
	test: {
		include: ["src/**/*.test.{ts,tsx}", "src-mobile/**/*.test.{ts,tsx}", "src-tauri/src/mobile/camera-web/*.test.js"],
		setupFiles: ["src/test/setupLocale.ts"],
	},
	// Tauri expects a fixed dev port and fails if it is taken.
	clearScreen: false,
	server: {
		port: process.env.VITE_PORT ? parseInt(process.env.VITE_PORT, 10) : 1421,
		strictPort: true,
		watch: {
			// Ignore backend, cache, docs, test files, and other worktree build outputs from triggering dev reload.
			ignored: [
				"**/src-tauri/**",
				"**/.cache/**",
				"**/docs/**",
				"**/*.test.{ts,tsx,js,jsx}",
				"**/.worktrees/*/dist/**",
				"**/.worktrees/*/mobile-dist/**",
				"**/.worktrees/*/target/**",
			],
		},
	},
	build: {
		// Tauri uses a custom protocol in production.
		target: "es2021",
	},
});
