/** Shared inline image/file token metrics, highlighting, and parsing for Composer & PromptComposer. */
import clsx from "clsx";
import type React from "react";
import { getImageTokenPalette } from "./imageTokens";

export interface InlineImageToken {
	match: string;
	index: number;
	path?: string;
}

/** Shared by the textarea and its token backdrop so glyph advances and wrapping stay identical. */
export const COMPOSER_TEXT_METRICS_CLASS =
	"whitespace-pre-wrap break-words font-sans text-[var(--chat-font-size,14px)] leading-[1.35]";
export const COMPOSER_TEXT_METRICS_STYLE = {
	letterSpacing: "normal",
	wordSpacing: "normal",
	fontKerning: "normal",
	fontVariantLigatures: "none",
	fontFeatureSettings: "normal",
	wordBreak: "normal",
	overflowWrap: "break-word",
	tabSize: 8,
} as const;

/** Interactive image tokens: the rendered token itself is the pointer target (see backdrop layering). */
export interface HighlightImageOpen {
	/** 1-based image number. */
	onOpen: (num: number) => void;
	/** Accessible name for an image token. */
	label: string;
	/** Only numbers with an attached image are interactive. */
	count: number;
}

export function renderHighlightedText(content: string, image?: HighlightImageOpen) {
	const regex = /(🖼️\s*#\d+|📎\s*#\d+|\[(?:Image|图片|File|文件)\s*#\d+\])/gu;
	const parts: React.ReactNode[] = [];
	let lastIdx = 0;
	let match: RegExpExecArray | null;
	// Plain text is mirrored for the textarea (already exposed to assistive tech): hide the copy
	// per span so the interactive tokens stay in the accessibility tree. Inline spans keep layout.
	const plain = (text: string, key: string) => (
		<span key={key} aria-hidden="true">
			{text}
		</span>
	);

	while ((match = regex.exec(content)) !== null) {
		if (match.index > lastIdx) {
			parts.push(plain(content.slice(lastIdx, match.index), `t${lastIdx}`));
		}
		const tokenText = match[0];
		const numMatch = /\d+/.exec(tokenText);
		const num = numMatch ? parseInt(numMatch[0], 10) : 1;
		const palette = getImageTokenPalette(num);
		const isImage = /^(?:🖼️|\[(?:Image|图片))/u.test(tokenText);
		const interactive = image !== undefined && isImage && num >= 1 && num <= image.count;

		parts.push(
			<span
				key={match.index}
				className={clsx(
					"underline decoration-2 underline-offset-[3px]",
					interactive &&
						"pointer-events-auto relative z-20 cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-current",
				)}
				style={{ color: palette.hex, textDecorationColor: palette.hex }}
				{...(interactive
					? {
							role: "button",
							tabIndex: 0,
							"aria-label": `${image.label} ${tokenText}`,
							title: image.label,
							// Keep the textarea focused and its caret untouched; the token only activates.
							onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
							onClick: () => image.onOpen(num),
							// Native button semantics: Enter/Space only while this control itself has focus.
							onKeyDown: (e: React.KeyboardEvent) => {
								if (e.key !== "Enter" && e.key !== " ") return;
								e.preventDefault();
								e.stopPropagation();
								image.onOpen(num);
							},
						}
					: { "aria-hidden": true })}
			>
				{tokenText}
			</span>,
		);
		lastIdx = regex.lastIndex;
	}

	if (lastIdx < content.length) {
		parts.push(plain(content.slice(lastIdx), `t${lastIdx}`));
	}
	if (content.endsWith("\n")) {
		parts.push("\n ");
	}
	return parts;
}

export function getImageTokenRanges(content: string): Array<{
	start: number;
	end: number;
	num: number;
	token: string;
}> {
	const regex = /(?:🖼️\s*#\d+|\[(?:Image|图片)\s*#\d+\])/gu;
	const ranges: Array<{ start: number; end: number; num: number; token: string }> = [];
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		const numMatch = /\d+/.exec(match[0]);
		const num = numMatch ? parseInt(numMatch[0], 10) : 1;
		ranges.push({
			start: match.index,
			end: match.index + match[0].length,
			num,
			token: match[0],
		});
	}
	return ranges;
}

export const INLINE_IMAGE_RE =
	/(?:\[(?:Image|图片)\s*#(?<num1>\d+)\]|🖼️\s*#(?<num2>\d+)|\[(?:Image|图片)\s*#(?<num3>\d+)(?:,\s*\d+x\d+)?:\s*(?<path3>[^\]]+)\])/gu;

export function parseInlineImages(
	text: string,
	knownImages?: Array<{ path: string }>,
): InlineImageToken[] {
	const tokens: InlineImageToken[] = [];
	const re = new RegExp(INLINE_IMAGE_RE.source, "gu");
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const numStr = m.groups?.num1 || m.groups?.num2 || m.groups?.num3 || "1";
		const num = parseInt(numStr, 10);
		let path = (m.groups?.path3 || "").trim() || undefined;
		if (!path && knownImages && knownImages[num - 1]) {
			path = knownImages[num - 1].path;
		}
		tokens.push({ match: m[0], index: num, path });
	}
	return tokens;
}

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

export function fileToBase64(file: File | Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const res = typeof reader.result === "string" ? reader.result : "";
			const idx = res.indexOf(",");
			resolve(idx >= 0 ? res.slice(idx + 1) : res);
		};
		reader.onerror = () => reject(reader.error ?? new Error("read failed"));
		reader.readAsDataURL(file);
	});
}
