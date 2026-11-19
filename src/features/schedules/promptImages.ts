/**
 * Scheduled-task instruction ↔ Composer draft with inline image & file tokens.
 * Stored prompts carry `[Image #N: path]` / `[文件 #N: path]` markers (the same
 * wire form Composer sends), so no backend schema change is required.
 */

const WIRE_RE = /\[(?:Image|图片)\s*#?\d*(?:,\s*\d+x\d+)?:\s*([^\]]+?)\s*\]/gu;
const FILE_WIRE_RE = /\[(?:File|文件)\s*#?\d*:\s*([^\]]+?)\s*\]/gu;
const COMPOSER_IMAGE_RE = /🖼️\s*#(\d+)/gu;
const COMPOSER_FILE_RE = /📎\s*#(\d+)/gu;

export interface ComposerAttachmentDoc {
	text: string;
	images: string[];
	files: string[];
}

/** Stored schedule prompt → Composer store draft + ordered unique image/file paths. */
export function promptToComposerDoc(prompt: string): ComposerAttachmentDoc {
	const images: string[] = [];
	const files: string[] = [];
	const withImages = prompt.replace(WIRE_RE, (_m, path: string) => {
		let i = images.indexOf(path);
		if (i < 0) {
			images.push(path);
			i = images.length - 1;
		}
		return `🖼️#${i + 1}`;
	});
	const text = withImages.replace(FILE_WIRE_RE, (_m, path: string) => {
		let i = files.indexOf(path);
		if (i < 0) {
			files.push(path);
			i = files.length - 1;
		}
		return `📎#${i + 1}`;
	});
	return { text, images, files };
}

/** Composer draft + attachments → stored schedule prompt; orphan tokens are dropped. */
export function composerDocToPrompt(
	text: string,
	images: ReadonlyArray<{ path?: string }>,
	files: ReadonlyArray<{ path?: string }>,
): string {
	const withImages = text.replace(COMPOSER_IMAGE_RE, (_m, n: string) => {
		const path = images[Number(n) - 1]?.path;
		return path ? `[Image #${n}: ${path}]` : "";
	});
	return withImages.replace(COMPOSER_FILE_RE, (_m, n: string) => {
		const path = files[Number(n) - 1]?.path;
		return path ? `[文件 #${n}: ${path}]` : "";
	});
}
