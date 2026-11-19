/** Shared attachment thumbnail/file-chip strip + lightbox modal for Composer and PromptComposer. */
import { ImagePreviewModal } from "../../components/ImagePreviewModal";
import { AttachmentThumb, FileChip } from "./ImageChips";

export interface ComposerImageItem {
	id?: string;
	path: string;
	name?: string;
}

export interface ComposerFileItem {
	id?: string;
	path: string;
	name?: string;
}

export function ComposerAttachmentStrip({
	images,
	files,
	previewImageIndex,
	onOpenImage,
	onClosePreview,
	onRemoveImage,
	onRemoveFile,
}: {
	images: readonly ComposerImageItem[];
	files: readonly ComposerFileItem[];
	previewImageIndex: number | null;
	onOpenImage: (index: number) => void;
	onClosePreview: () => void;
	onRemoveImage: (index: number) => void;
	onRemoveFile: (index: number) => void;
}) {
	return (
		<>
			{(images.length > 0 || files.length > 0) && (
				<div className="flex flex-wrap items-center gap-1.5 px-3.5 pt-2.5">
					{images.map((img, i) => (
						<AttachmentThumb
							key={img.id || `${i + 1}-${img.path}`}
							path={img.path}
							index={i + 1}
							showIndex
							variant="strip"
							onOpen={() => onOpenImage(i)}
							onRemove={() => onRemoveImage(i)}
						/>
					))}
					{files.map((f, i) => (
						<FileChip
							key={f.id || `${i + 1}-${f.path}`}
							path={f.path}
							index={i + 1}
							name={f.name}
							variant="strip"
							onRemove={() => onRemoveFile(i)}
						/>
					))}
				</div>
			)}
			{previewImageIndex !== null && (
				<ImagePreviewModal
					images={images.map((img, i) => ({
						path: img.path,
						name: img.name,
						marker: `🖼️#${i + 1}`,
					}))}
					initialIndex={previewImageIndex}
					onClose={onClosePreview}
				/>
			)}
		</>
	);
}
