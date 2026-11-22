/** Image attach controls shared by the annotation comment inputs: paste handler,
 * file-picker button and the removable thumbnail strip. */

import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Image as ImageIcon, ImageOff, ImagePlus, X } from "lucide-react";
import { type ClipboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { ImagePreviewModal } from "../../components/ImagePreviewModal";
import { errMsg } from "../../lib/dialogs";
import { clipboardFilePaths, importImageFile, saveClipboardImage } from "../../lib/ipc";
import { toast } from "../../lib/toast";
import { imageFileToBase64 } from "../sidechat/sideChatAttachments";
import { tNow, useT } from "../../stores/language";

/** Formats the canonical image converter accepts (bmp/avif/heic are rejected there). */
const SUPPORTED_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const SUPPORTED_PATH_RE = new RegExp(`\\.(?:${SUPPORTED_EXTENSIONS.join("|")})$`, "iu");

/** Settle every job: keep the paths that worked, report the first failure (no silent fallback to the source path). */
async function settleAll(jobs: Promise<string>[]): Promise<string[]> {
	const results = await Promise.allSettled(jobs);
	const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
	if (failed) toast.error(tNow("chat.annotation.imageFailed", { error: errMsg(failed.reason) }));
	return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

/**
 * Paste/pick handlers that append stored image paths through `onChange`.
 * - `paths` is read through a ref so concurrent additions never overwrite each other.
 * - `pendingRef`/`busy` count in-flight additions (several pastes can overlap).
 * - `invalidate()` makes every in-flight addition drop its result: call it when the
 *   draft is discarded or replaced so a late completion cannot leak into another one.
 * - `onIdle` fires (after the result was appended) when the last pending addition ends.
 */
export function useAnnotationImages(
	paths: readonly string[],
	onChange: (next: string[]) => void,
	onIdle?: () => void,
) {
	const [pending, setPending] = useState(0);
	const pendingRef = useRef(0);
	const genRef = useRef(0);
	const pathsRef = useRef(paths);
	pathsRef.current = paths;
	const onIdleRef = useRef(onIdle);
	onIdleRef.current = onIdle;

	const append = useCallback(
		(added: string[]) => {
			const next = [...pathsRef.current];
			for (const p of added) if (!next.includes(p)) next.push(p);
			pathsRef.current = next;
			onChange(next);
		},
		[onChange],
	);

	const run = useCallback(
		async (work: () => Promise<string[]>) => {
			const gen = genRef.current;
			pendingRef.current += 1;
			setPending(pendingRef.current);
			try {
				const added = await work();
				// Discarded/replaced draft: the result belongs to nobody.
				if (gen === genRef.current && added.length > 0) append(added);
			} catch (err) {
				if (gen === genRef.current) {
					toast.error(tNow("chat.annotation.imageFailed", { error: errMsg(err) }));
				}
			} finally {
				// An invalidated run was already written off by invalidate(); never double-count it.
				if (gen === genRef.current) {
					pendingRef.current -= 1;
					setPending(pendingRef.current);
					if (pendingRef.current === 0) onIdleRef.current?.();
				}
			}
		},
		[append],
	);

	const invalidate = useCallback(() => {
		genRef.current += 1;
		pendingRef.current = 0;
		setPending(0);
	}, []);

	const remove = useCallback(
		(path: string) => {
			const next = pathsRef.current.filter((p) => p !== path);
			pathsRef.current = next;
			onChange(next);
		},
		[onChange],
	);

	const onPaste = useCallback(
		(e: ClipboardEvent<HTMLElement>) => {
			const data = e.clipboardData;
			if (!data) return;
			const imageFiles: File[] = [];
			for (const item of Array.from(data.items)) {
				if (item.kind !== "file") continue;
				const f = item.getAsFile();
				if (f?.type.startsWith("image/")) imageFiles.push(f);
			}
			const hasFiles = data.types.includes("Files");
			if (imageFiles.length === 0 && !hasFiles) return; // plain text paste
			// Suppress before any await so a filename never lands in the comment.
			e.preventDefault();
			void run(async () => {
				// Finder copy: real paths on the pasteboard.
				const native = hasFiles ? await clipboardFilePaths().catch(() => [] as string[]) : [];
				const nativeImages = native.filter((p) => SUPPORTED_PATH_RE.test(p));
				if (nativeImages.length > 0) return settleAll(nativeImages.map((p) => importImageFile(p)));
				// Screenshot-style image data.
				return settleAll(imageFiles.map(async (f) => saveClipboardImage(await imageFileToBase64(f))));
			});
		},
		[run],
	);

	const pick = useCallback(() => {
		void run(async () => {
			const selected = await openDialog({
				multiple: true,
				directory: false,
				title: tNow("chat.annotation.pickImageTitle"),
				filters: [{ name: tNow("chat.annotation.imageFilter"), extensions: SUPPORTED_EXTENSIONS }],
			});
			const list = Array.isArray(selected) ? selected : selected ? [selected] : [];
			return settleAll(list.map((p) => importImageFile(p)));
		});
	}, [run]);

	return { busy: pending > 0, pendingRef, invalidate, onPaste, pick, remove };
}

/** Small icon button opening the image file picker. */
export function AnnotationImageButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
	const { t } = useT();
	return (
		<button
			type="button"
			aria-label={t("chat.annotation.addImage")}
			title={t("chat.annotation.addImageTitle")}
			// Overlapping additions are supported; the button stays usable while one is pending.
			aria-busy={busy || undefined}
			onClick={onClick}
			className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--text-40)] transition-colors hover:bg-[var(--ghost-hover)] hover:text-[var(--text)] aria-busy:opacity-50"
			// Keep focus in the comment input (its blur may save/close the editor).
			onMouseDown={(e) => e.preventDefault()}
		>
			<ImagePlus size={14} />
		</button>
	);
}

function AnnotationThumbTile({
	path,
	alt,
	removeLabel,
	cannotPreviewTitle,
	onOpen,
	onRemove,
}: {
	path: string;
	alt: string;
	removeLabel: string;
	cannotPreviewTitle: string;
	onOpen: () => void;
	onRemove?: () => void;
}) {
	const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
	useEffect(() => {
		setStatus("loading");
	}, [path]);

	return (
		<div
			className="group/thumb relative h-10 w-10 shrink-0 overflow-hidden rounded-md border border-[var(--line,var(--border))] bg-[var(--well-bg)]"
			title={status === "error" ? cannotPreviewTitle : path}
		>
			<button
				type="button"
				onMouseDown={(e) => e.preventDefault()}
				onClick={(e) => {
					e.stopPropagation();
					onOpen();
				}}
				aria-label={alt}
				className="relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
			>
				{status === "error" ? (
					<ImageOff size={14} className="text-[var(--text-40)]" aria-hidden="true" />
				) : (
					<>
						{status === "loading" && (
							<ImageIcon size={14} className="absolute text-[var(--text-30)]" aria-hidden="true" />
						)}
						<img
							src={convertFileSrc(path)}
							alt={alt}
							onLoad={() => setStatus("loaded")}
							onError={() => setStatus("error")}
							className={`h-full w-full object-cover transition-opacity duration-150 ${status === "loaded" ? "opacity-100" : "opacity-0"}`}
							draggable={false}
						/>
					</>
				)}
				<div className="pointer-events-none absolute inset-0 bg-white/10 opacity-0 transition-opacity duration-150 group-hover/thumb:opacity-100" />
			</button>
			{onRemove && (
				<button
					type="button"
					aria-label={removeLabel}
					title={removeLabel}
					// Keep focus in the comment input (blur would otherwise save/close).
					onMouseDown={(e) => e.preventDefault()}
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					className="absolute right-0 top-0 z-10 flex h-4 w-4 items-center justify-center rounded-bl bg-black/60 text-white opacity-80 hover:opacity-100"
				>
					<X size={10} />
				</button>
			)}
		</div>
	);
}

/** Compact thumbnails with loading/error placeholder and click-to-preview; pass `onRemove` for the editable variant (× button). */
export function AnnotationImageStrip({
	paths,
	onRemove,
	onOpenPath,
	className = "",
}: {
	paths: readonly string[] | undefined;
	onRemove?: (path: string) => void;
	/** Optional external preview handler (e.g. sent message gallery); defaults to built-in lightbox. */
	onOpenPath?: (path: string, index: number) => void;
	className?: string;
}) {
	const { t } = useT();
	const [previewIndex, setPreviewIndex] = useState<number | null>(null);
	if (!paths || paths.length === 0) return null;
	return (
		<>
			<div className={`flex flex-wrap gap-1.5 ${className}`}>
				{paths.map((p, i) => (
					<AnnotationThumbTile
						key={p}
						path={p}
						alt={t("chat.annotation.imageAlt")}
						removeLabel={t("chat.annotation.removeImage")}
						cannotPreviewTitle={t("chat.cannotPreview", { path: p })}
						onOpen={() => {
							if (onOpenPath) onOpenPath(p, i);
							else setPreviewIndex(i);
						}}
						onRemove={onRemove ? () => onRemove(p) : undefined}
					/>
				))}
			</div>
			{!onOpenPath && previewIndex !== null && (
				<ImagePreviewModal
					images={paths.map((p, idx) => ({
						path: p,
						marker: t("chat.execution.imageMarker", { num: idx + 1 }),
					}))}
					initialIndex={previewIndex}
					onClose={() => setPreviewIndex(null)}
				/>
			)}
		</>
	);
}
