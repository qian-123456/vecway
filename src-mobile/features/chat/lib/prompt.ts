/** Prompt assembly for `POST /sessions/{id}/prompt-ex`: attachment tokens, native images, steer/queue payload, optimistic rows. */
import type { PromptImage } from "../../../core/lib/images";

export type StreamBehavior = "steer" | "followUp";

export interface AttachmentLike {
	isImage: boolean;
	status: "up" | "ok" | "err";
	path?: string;
	image?: PromptImage;
}

/**
 * Non-image files become `[文件 #n: path]` tokens in front of the text.
 * Images encoded for native `images` delivery omit `[Image #n: path]` markers;
 * path-only legacy images fall back to `[Image #n: path]` so nothing is lost.
 */
export function buildPrompt(text: string, atts: readonly AttachmentLike[]): string {
	let ni = 0;
	let nf = 0;
	const toks: string[] = [];
	for (const a of atts) {
		if (a.status !== "ok") continue;
		if (a.isImage) {
			if (!a.image && a.path) toks.push(`[Image #${++ni}: ${a.path}]`);
		} else if (a.path) {
			toks.push(`[文件 #${++nf}: ${a.path}]`);
		}
	}
	return (toks.join(" ") + (toks.length && text ? " " : "") + text).trim();
}

/** Collect native `{ mime, data }` payloads from ready image attachments. */
export function buildPromptImages(atts: readonly AttachmentLike[]): PromptImage[] {
	const out: PromptImage[] = [];
	for (const a of atts) {
		if (a.status === "ok" && a.isImage && a.image) out.push(a.image);
	}
	return out;
}

/** Remove residual `[Image #N: ...]` / `[图片 #N]` / `🖼️#N` markers from display text. */
export function stripImageMarkers(text: string): string {
	return text
		.replace(
			/\[\d+\]\s*\([^)]*?\.(?:png|jpe?g|gif|webp|svg|bmp)[^)]*\)\s*\n?>?\s*(?:\[图片:[^\]]+\])?/gi,
			"",
		)
		.replace(
			/\[(?:Image|图片)\s*#\d+(?:,\s*\d+x\d+)?(?::\s*[^\]]+)?\]|\[图片(?::\s*[^\]]+)?\]|🖼️\s*#\d+/gu,
			"",
		)
		.trim();
}

export interface PromptBody {
	text: string;
	images: PromptImage[];
	/** Only present while a turn is streaming. */
	streamingBehavior?: StreamBehavior;
}

export function buildPromptBody(
	text: string,
	streaming: boolean,
	behavior: StreamBehavior,
	images: readonly PromptImage[] = [],
): PromptBody {
	const body: PromptBody = { text, images: [...images] };
	if (streaming) body.streamingBehavior = behavior;
	return body;
}
/** Pre-send validation shared by the composer: returns a toast message or null when sending may proceed. */
export function attachmentBlocker(atts: readonly AttachmentLike[]): string | null {
	if (atts.some((a) => a.status === "up")) return "附件上传中，请稍候";
	if (atts.some((a) => a.status === "err")) return "有附件上传失败，请移除后再发送";
	return null;
}

export type SendIntent = "stop" | "slash" | "prompt" | "none";

/** What the send button does for the current composer content. */
export function sendIntent(text: string, attCount: number, working: boolean): SendIntent {
	const t = text.trim();
	if (!t && attCount === 0) return working ? "stop" : "none";
	if (attCount === 0 && t.startsWith("/")) return "slash";
	return "prompt";
}

/** Label of the steer/queue choice shown while streaming. */
export const BEHAVIOR_LABEL: Record<StreamBehavior, string> = { steer: "插话", followUp: "排队" };
export const BEHAVIOR_HINT: Record<StreamBehavior, string> = {
	steer: "立即把这条消息交给正在运行的回合",
	followUp: "等当前回合结束后再发送",
};
