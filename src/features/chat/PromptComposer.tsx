/**
 * Non-session prompt builder composed from shared Composer building blocks:
 * ContextPillBar ear tabs, compact auto-growing token-highlighted textarea,
 * attachment strip, `@` file & `/skill:` completion, and Model + Thinking pickers.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import { Plus } from "lucide-react";
import {
	lazy,
	Suspense,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { resolveModelCapabilities } from "../../components/modelSelectLogic";
import { PhoneCameraDialog } from "../../components/PhoneCameraDialog";
import type { Workspace } from "../../lib/contracts";
import { errMsg } from "../../lib/dialogs";
import { isComposing } from "../../lib/hooks";
import {
	clipboardFilePaths,
	importImageFile,
	ompConfigList,
	saveClipboardFile,
	saveClipboardImage,
	skillsList,
	validatePath,
} from "../../lib/ipc";
import {
	pickCurrentModel,
	resolveThinkingLevels,
	thinkingChipState,
} from "../../lib/models";
import { trimTrailingSlash } from "../../lib/paths";
import { DEFAULT_SKILL_CONFIG, parseSkillConfig } from "../../lib/skillEnablement";
import { toast } from "../../lib/toast";
import { useT } from "../../stores/language";
import type { SlashCommand } from "../../stores/live";
import { useModelCatalog, useModelOptions } from "../../stores/modelCatalog";
import { useSessions } from "../../stores/sessions";
import {
	composerDocToPrompt,
	promptToComposerDoc,
} from "../schedules/promptImages";
import {
	composeScheduleModelSelection,
	parseScheduleModelSelection,
} from "../schedules/scheduleUtils";
import { AddMenuPopover } from "./AddMenuPopover";
import { AtFileMenu, useAtFileMenu } from "./AtFileMenu";
import {
	ComposerAttachmentStrip,
	type ComposerFileItem,
	type ComposerImageItem,
} from "./ComposerAttachmentStrip";
import { ComposerModelControls } from "./ComposerModelControls";
import { syncAttachmentTokens } from "./composerRelease";
import {
	COMPOSER_TEXT_METRICS_CLASS,
	COMPOSER_TEXT_METRICS_STYLE,
	fileToBase64,
	getImageTokenRanges,
	IMAGE_EXT_RE,
	renderHighlightedText,
	type HighlightImageOpen,
} from "./composerTextTokens";
import { pickToolbarTier, TIER_TIGHT } from "./composerToolbar";
import {
	ContextPillBar,
	WorkspacePickerPopover,
	type AutomationEarConfig,
} from "./ContextPillBar";
import { baseName, getFileTokenRanges } from "./fileAttach";
import {
	buildSlashSections,
	flattenSections,
	type SlashMenuItem,
} from "./slash/menu";
import { skillCommandsFromCatalog } from "./slash/skillCatalog";
import { SlashMenu } from "./slash/SlashMenu";
import { useDraftDefaultModel } from "./useDraftDefaultModel";

const SketchPad = lazy(() =>
	import("./sketch/SketchPad").then((m) => ({ default: m.SketchPad })),
);

const EMPTY_COMMANDS: SlashCommand[] = [];

interface SlashToken {
	query: string;
	start: number;
	end: number;
}

function getSlashToken(text: string, cursorPos: number): SlashToken | null {
	const before = text.slice(0, cursorPos);
	const m = /(?:^|\s)\/([^\s/]*)$/.exec(before);
	if (!m) return null;
	const start = before.length - m[1].length - 1;
	return { query: m[1], start, end: cursorPos };
}

function hydrateDoc(prompt: string): {
	text: string;
	images: ComposerImageItem[];
	files: ComposerFileItem[];
} {
	const doc = promptToComposerDoc(prompt);
	return {
		text: doc.text,
		images: doc.images.map((path, i) => ({
			id: `cfg-img-${i + 1}-${path}`,
			path,
		})),
		files: doc.files.map((path, i) => ({
			id: `cfg-file-${i + 1}-${path}`,
			path,
			name: baseName(path),
		})),
	};
}

export interface PromptComposerProps {
	/** Stable identifier used for test/accessibility attributes. */
	id?: string;
	placeholder?: string;
	/** Project working directory for ear-tab picker, `@` file completion, disk skills, and default model lookup. */
	cwd: string;
	/** Main Git repository root (when known) so linked worktrees keep resolving to their parent project. */
	repoRoot?: string | null;
	onChangeCwd: (cwd: string) => void;
	workspaceMode?: Workspace["mode"];
	runMode: "local" | "worktree";
	isGitRepo: boolean;
	onChangeRunMode: (mode: "local" | "worktree") => void;
	hasPromptError?: boolean;
	hasCwdError?: boolean;
	/** Model selector string: "" (follow default) or "provider/id" or "provider/id:level" or ":level". */
	modelValue: string;
	onChangeModel: (value: string) => void;
	/** Persisted prompt carrying `[Image #N: path]` / `[文件 #N: path]` markers. */
	promptValue: string;
	onChangePrompt: (prompt: string) => void;
	/** Right-side ear action (e.g. jump to AI assist chat). */
	earRightAction?: ReactNode;
	/** Right-side bottom toolbar controls (e.g. approval mode). */
	trailingControls?: ReactNode;
}

export function PromptComposer({
	id = "prompt-composer",
	placeholder,
	cwd,
	repoRoot,
	onChangeCwd,
	workspaceMode,
	runMode,
	isGitRepo,
	onChangeRunMode,
	hasPromptError,
	hasCwdError,
	modelValue,
	onChangeModel,
	promptValue,
	onChangePrompt,
	earRightAction,
	trailingControls,
}: PromptComposerProps) {
	const { t } = useT();
	const effectiveCwd = cwd.trim() || null;

	const [doc, setDoc] = useState(() => hydrateDoc(promptValue));
	const lastEmittedRef = useRef<string>(promptValue);
	const onChangePromptRef = useRef(onChangePrompt);
	onChangePromptRef.current = onChangePrompt;

	// Re-hydrate when parent replaces promptValue externally (e.g. switching schedule or resetting form).
	useLayoutEffect(() => {
		if (promptValue === lastEmittedRef.current) return;
		lastEmittedRef.current = promptValue;
		setDoc(hydrateDoc(promptValue));
	}, [promptValue]);

	const commitDoc = (next: {
		text: string;
		images: ComposerImageItem[];
		files: ComposerFileItem[];
	}) => {
		setDoc(next);
		const serialized = composerDocToPrompt(next.text, next.images, next.files);
		if (serialized !== lastEmittedRef.current) {
			lastEmittedRef.current = serialized;
			onChangePromptRef.current(serialized);
		}
	};

	const { text, images, files } = doc;
	const hasImageTokens = useMemo(
		() => /(?:🖼️\s*#\d+|📎\s*#\d+|\[(?:Image|图片|File|文件)\s*#\d+\])/u.test(text),
		[text],
	);

	const taRef = useRef<HTMLTextAreaElement>(null);
	const backdropRef = useRef<HTMLDivElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	const addBtnRef = useRef<HTMLButtonElement>(null);
	const wsPillBtnRef = useRef<HTMLButtonElement>(null);
	const toolbarRef = useRef<HTMLDivElement>(null);
	const workspacePickerIgnoreRefs = useMemo(() => [wsPillBtnRef, addBtnRef], []);

	const [cursorPos, setCursorPos] = useState(0);
	const [menuIndex, setMenuIndex] = useState(0);
	const [menuDismissed, setMenuDismissed] = useState(false);
	const [isDraggingOver, setIsDraggingOver] = useState(false);
	const [addMenuOpen, setAddMenuOpen] = useState(false);
	const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
	const [previewImageIndex, setPreviewImageIndex] = useState<number | null>(null);
	const [cameraOpen, setCameraOpen] = useState(false);
	const [sketchOpen, setSketchOpen] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);

	// Compact auto-resizing textarea (same single-line 26px baseline as main chat Composer).
	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		const fit = () => {
			const savedScrollTop = ta.scrollTop;
			ta.style.height = "auto";
			const minH = 26;
			const maxH = 220;
			const nextH = Math.min(Math.max(ta.scrollHeight, minH), maxH);
			const scrollable = ta.scrollHeight > maxH;
			ta.style.height = `${nextH}px`;
			ta.style.overflowX = "hidden";
			ta.style.overflowY = scrollable ? "auto" : "hidden";
			ta.scrollLeft = 0;
			ta.scrollTop = scrollable ? savedScrollTop : 0;
			if (backdropRef.current) {
				backdropRef.current.style.height = `${nextH}px`;
				const gutter = ta.offsetWidth - ta.clientWidth;
				backdropRef.current.style.paddingRight = `calc(1rem + ${Math.max(gutter, 0)}px)`;
				backdropRef.current.scrollTop = ta.scrollTop;
			}
		};
		fit();
		let lastWidth = ta.clientWidth;
		const ro = new ResizeObserver(() => {
			if (ta.clientWidth === lastWidth) return;
			lastWidth = ta.clientWidth;
			fit();
		});
		ro.observe(ta);
		return () => ro.disconnect();
	}, [text]);

	// React 19 registers JSX `onWheel` as passive, so attach a native non-passive
	// listener to block horizontal trackpad swipes from panning the textarea sideways.
	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		const handleWheel = (e: WheelEvent) => {
			if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && e.deltaX !== 0) {
				e.preventDefault();
				ta.scrollLeft = 0;
			}
		};
		ta.addEventListener("wheel", handleWheel, { passive: false });
		return () => ta.removeEventListener("wheel", handleWheel);
	}, []);

	// Workspace `@` file completion.
	const { atToken, atMenu, dismiss: dismissAtMenu } = useAtFileMenu(
		effectiveCwd,
		text,
		cursorPos,
		id,
	);
	useEffect(() => setMenuIndex(0), [atToken?.query]);

	// Disk `/skill:*` completion.
	const [diskSkills, setDiskSkills] = useState<SlashCommand[] | null>(null);
	const slashToken = useMemo(
		() => (menuDismissed ? null : getSlashToken(text, cursorPos)),
		[text, cursorPos, menuDismissed],
	);
	useEffect(() => {
		if (!slashToken) return;
		let cancelled = false;
		void Promise.all([
			skillsList(effectiveCwd),
			Promise.resolve()
				.then(() => ompConfigList())
				.then(parseSkillConfig, () => DEFAULT_SKILL_CONFIG),
		])
			.then(([cat, cfg]) => {
				if (!cancelled) setDiskSkills(skillCommandsFromCatalog(cat.skills, cfg));
			})
			.catch((err) => console.warn("[prompt-composer] skills list failed", err));
		return () => {
			cancelled = true;
		};
	}, [slashToken !== null, effectiveCwd]);

	const slashSections = useMemo(() => {
		if (!slashToken) return [];
		const hasOtherText =
			text.slice(0, slashToken.start).trim().length > 0 ||
			text.slice(slashToken.end).trim().length > 0;
		return buildSlashSections(
			slashToken.query,
			diskSkills ?? EMPTY_COMMANDS,
			hasOtherText,
			{ visualizeEnabled: false, promptOnly: true },
		);
	}, [slashToken, diskSkills, text]);
	const slashItems = useMemo(() => flattenSections(slashSections), [slashSections]);
	useEffect(() => setMenuIndex(0), [slashToken?.query]);

	// Model & thinking picker state.
	const models = useModelOptions();
	const parsedModel = useMemo(
		() => parseScheduleModelSelection(modelValue),
		[modelValue],
	);
	const currentThinking = parsedModel.level ?? "auto";
	const draftDefaultModel = useDraftDefaultModel(
		!parsedModel.selector,
		effectiveCwd,
		models,
	);
	const currentModel = useMemo(
		() => pickCurrentModel([parsedModel.selector || draftDefaultModel], models),
		[parsedModel.selector, draftDefaultModel, models],
	);
	const currentModelOption = useMemo(
		() => resolveModelCapabilities(currentModel.value, models, undefined),
		[models, currentModel.value],
	);
	const thinkingLevels = useMemo(
		() =>
			resolveThinkingLevels(
				undefined,
				currentModelOption?.thinking,
				parsedModel.level,
			),
		[currentModelOption?.thinking, parsedModel.level],
	);

	const [toolbarWidth, setToolbarWidth] = useState(0);
	useLayoutEffect(() => {
		const el = toolbarRef.current;
		if (!el) return;
		const measure = () => setToolbarWidth(el.clientWidth);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const modelLabel = currentModel.value
		? currentModel.label
		: models === null
			? t("chat.loadingShort")
			: t("composer.selectModel");
	const thinkingKind = thinkingChipState(
		thinkingLevels,
		currentModelOption?.reasoning,
	).kind;
	const toolbarTier = pickToolbarTier({
		width: toolbarWidth,
		modelLabel,
		thinkingKind,
		thinkingLevel: currentThinking,
		extra: 0,
	});

	const handleSelectModel = (key: string) => {
		const level = parsedModel.level;
		onChangeModel(
			composeScheduleModelSelection(
				key,
				level && level !== "auto" ? level : null,
			),
		);
	};

	const handleSelectThinking = (level: string) => {
		onChangeModel(
			composeScheduleModelSelection(
				parsedModel.selector ?? "",
				level === "auto" ? null : level,
			),
		);
	};

	// Workspace ear configuration.
	const workspaceId = useSessions((s) => {
		const normCwd = trimTrailingSlash(cwd);
		const normRoot = repoRoot ? trimTrailingSlash(repoRoot) : null;
		return (
			s.workspaces.find((w) => {
				const wp = trimTrailingSlash(w.path);
				return wp === normCwd || (normRoot !== null && wp === normRoot);
			})?.id ?? null
		);
	});
	const automationEar = useMemo<AutomationEarConfig>(
		() => ({
			cwd,
			repoRoot,
			workspaceMode,
			runMode,
			isGitRepo,
			onChangeRunMode,
			onChangeCwd,
			hasCwdError,
			rightAction: earRightAction,
		}),
		[
			cwd,
			repoRoot,
			workspaceMode,
			runMode,
			isGitRepo,
			onChangeRunMode,
			onChangeCwd,
			hasCwdError,
			earRightAction,
		],
	);

	// Attachment insertion & removal helpers.
	const docRef = useRef(doc);
	docRef.current = doc;

	const insertTokenAtCursor = (
		token: string,
		nextImages: ComposerImageItem[],
		nextFiles: ComposerFileItem[],
	) => {
		const cur = docRef.current;
		const ta = taRef.current;
		const pos = ta ? (ta.selectionStart ?? cur.text.length) : cur.text.length;
		const end = ta ? (ta.selectionEnd ?? pos) : pos;
		const before = cur.text.slice(0, pos);
		const after = cur.text.slice(end);
		const padBefore = before.length > 0 && !/\s$/.test(before) ? " " : "";
		const padAfter = after.length > 0 && !/^\s/.test(after) ? " " : "";
		const nextText = `${before}${padBefore}${token}${padAfter}${after}`;
		const nextCaret = before.length + padBefore.length + token.length + padAfter.length;
		commitDoc({ text: nextText, images: nextImages, files: nextFiles });
		setCursorPos(nextCaret);
		setTimeout(() => {
			const el = taRef.current;
			if (!el) return;
			el.focus({ preventScroll: true });
			el.setSelectionRange(nextCaret, nextCaret);
		}, 0);
	};

	const insertImagePath = async (
		imagePath: string,
		name?: string,
		isCurrent?: () => boolean,
	): Promise<boolean> => {
		try {
			const stored = isCurrent
				? imagePath
				: await importImageFile(imagePath).catch(() => imagePath);
			if (isCurrent && !isCurrent()) return false;
			const cur = docRef.current;
			const nextNum = cur.images.length + 1;
			const nextImages = [
				...cur.images,
				{ id: `cfg-img-${Date.now()}-${nextNum}`, path: stored, name },
			];
			insertTokenAtCursor(`🖼️#${nextNum}`, nextImages, cur.files);
			toast.success(t("composer.insertedImage", { num: nextNum }));
			return true;
		} catch (err) {
			toast.error(t("composer.processImageFailed", { error: errMsg(err) }));
			return false;
		}
	};

	const insertFilePath = (filePath: string, name?: string) => {
		const cur = docRef.current;
		const nextNum = cur.files.length + 1;
		const nextFiles = [
			...cur.files,
			{
				id: `cfg-file-${Date.now()}-${nextNum}`,
				path: filePath,
				name: name || baseName(filePath),
			},
		];
		insertTokenAtCursor(`📎#${nextNum}`, cur.images, nextFiles);
		toast.success(t("composer.insertedFile", { num: nextNum }));
	};

	const processImageBlob = async (file: File | Blob) => {
		try {
			const base64 = await fileToBase64(file);
			const savedPath = await saveClipboardImage(base64);
			await insertImagePath(
				savedPath,
				file instanceof File ? file.name : undefined,
			);
		} catch (err) {
			toast.error(t("composer.processImageFailed", { error: errMsg(err) }));
		}
	};

	const processFileBlob = async (file: File) => {
		try {
			const base64 = await fileToBase64(file);
			const savedPath = await saveClipboardFile(base64, file.name || undefined);
			insertFilePath(savedPath, file.name || undefined);
		} catch (err) {
			toast.error(t("composer.attachFileFailed", { error: errMsg(err) }));
		}
	};

	const attachPath = async (filePath: string) => {
		let isDir = false;
		try {
			isDir = (await validatePath(filePath)).isDir;
		} catch {
			isDir = false;
		}
		if (!isDir && IMAGE_EXT_RE.test(filePath)) {
			await insertImagePath(filePath);
		} else {
			insertFilePath(
				filePath,
				isDir ? `${baseName(filePath)}/` : baseName(filePath),
			);
		}
	};

	const handleAddAttachment = async () => {
		try {
			const selected = await openDialog({
				multiple: true,
				directory: false,
				title: t("composer.selectAttachFiles"),
			});
			if (!selected) return;
			const paths = typeof selected === "string" ? [selected] : selected;
			for (const p of paths) await attachPath(p);
			if (paths.length > 0) {
				toast.success(t("composer.addedFileRefs", { count: paths.length }));
			}
		} catch (err) {
			toast.error(t("composer.openFileDialogFailed", { error: errMsg(err) }));
		}
	};

	const handleInsertSketch = async (dataUrl: string) => {
		setSketchOpen(false);
		try {
			const blob = await (await fetch(dataUrl)).blob();
			await processImageBlob(
				new File([blob], `sketch-${Date.now()}.png`, { type: "image/png" }),
			);
		} catch (err) {
			toast.error(t("composer.insertSketchFailed", { error: errMsg(err) }));
		}
	};

	const applySyncedText = (nextText: string) => {
		const synced = syncAttachmentTokens(nextText, images.length, files.length);
		commitDoc({
			text: synced.text,
			images: synced.images ? synced.images.map((i) => images[i]) : images,
			files: synced.files ? synced.files.map((i) => files[i]) : files,
		});
	};

	const removeImageByIndex = (idx: number) => {
		const num = idx + 1;
		const stripped = text.replace(
			new RegExp(`\\s*(?:🖼️\\s*#${num}|\\[(?:Image|图片)\\s*#${num}\\])`, "gu"),
			"",
		);
		applySyncedText(stripped);
	};

	const removeFileByIndex = (idx: number) => {
		const num = idx + 1;
		const stripped = text.replace(
			new RegExp(`\\s*(?:📎\\s*#${num}|\\[(?:File|文件)\\s*#${num}\\])`, "gu"),
			"",
		);
		applySyncedText(stripped);
	};

	const applyAtCompletion = (path: string) => {
		if (!atToken) return;
		const before = text.slice(0, atToken.start);
		const after = text.slice(cursorPos);
		const inserted = `@${path} `;
		const nextText = before + inserted + after;
		const nextPos = before.length + inserted.length;
		commitDoc({ text: nextText, images, files });
		setCursorPos(nextPos);
		setTimeout(() => {
			taRef.current?.focus();
			taRef.current?.setSelectionRange(nextPos, nextPos);
		}, 0);
	};

	const applySlashSkill = (item: SlashMenuItem) => {
		if (!slashToken) return;
		const before = text.slice(0, slashToken.start);
		const after = text.slice(slashToken.end);
		const inserted = `/${item.name} `;
		const nextText = before + inserted + after;
		const nextPos = before.length + inserted.length;
		commitDoc({ text: nextText, images, files });
		setCursorPos(nextPos);
		setMenuDismissed(false);
		setTimeout(() => {
			taRef.current?.focus();
			taRef.current?.setSelectionRange(nextPos, nextPos);
		}, 0);
	};

	const tokenRanges = useMemo(
		() => [
			...getImageTokenRanges(text),
			...getFileTokenRanges(text),
		],
		[text],
	);

	const imageOpen: HighlightImageOpen = {
		onOpen: (num) => setPreviewImageIndex(num - 1),
		label: t("chat.clickToZoom"),
		count: images.length,
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (isComposing(e)) return;
		if (atMenu.length > 0 && atToken) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setMenuIndex((i) => (i + 1) % atMenu.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setMenuIndex((i) => (i - 1 + atMenu.length) % atMenu.length);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				applyAtCompletion(atMenu[Math.min(menuIndex, atMenu.length - 1)]);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				dismissAtMenu();
				return;
			}
		}
		if (slashToken && slashItems.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setMenuIndex((i) => (i + 1) % slashItems.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setMenuIndex((i) => (i - 1 + slashItems.length) % slashItems.length);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				applySlashSkill(slashItems[Math.min(menuIndex, slashItems.length - 1)]);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setMenuDismissed(true);
				return;
			}
		}
	};

	const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		const fileItems: File[] = [];
		const types = e.clipboardData ? Array.from(e.clipboardData.types) : [];
		for (let i = 0; i < items.length; i++) {
			if (items[i].kind !== "file") continue;
			const f = items[i].getAsFile();
			if (f) fileItems.push(f);
		}
		const hasFilesType = types.includes("Files");
		if (fileItems.length === 0 && !hasFilesType) return;
		e.preventDefault();

		const imageFiles = fileItems.filter((f) => f.type.startsWith("image/"));
		const nonImageFiles = fileItems.filter((f) => !f.type.startsWith("image/"));
		let nativePaths: string[] = [];
		if (nonImageFiles.length > 0 || hasFilesType) {
			nativePaths = await clipboardFilePaths().catch(() => []);
		}
		if (nativePaths.length === 0 && nonImageFiles.length === 0) {
			for (const img of imageFiles) await processImageBlob(img);
			return;
		}
		const covered = new Set(nativePaths.map((p) => baseName(p).toLowerCase()));
		for (const p of nativePaths) await attachPath(p);
		for (const f of fileItems) {
			if (f.name && covered.has(f.name.toLowerCase())) continue;
			if (f.type.startsWith("image/")) await processImageBlob(f);
			else await processFileBlob(f);
		}
	};

	const hasDraggedFiles = (e: React.DragEvent) =>
		Array.from(e.dataTransfer?.types ?? []).includes("Files");

	const onDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
		if (!hasDraggedFiles(e)) return;
		e.preventDefault();
		e.stopPropagation();
		setIsDraggingOver(true);
	};

	const onDragLeave = (e: React.DragEvent<HTMLTextAreaElement>) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDraggingOver(false);
	};

	const onDrop = async (e: React.DragEvent<HTMLTextAreaElement>) => {
		if (!hasDraggedFiles(e)) return;
		e.preventDefault();
		e.stopPropagation();
		setIsDraggingOver(false);
		for (const file of Array.from(e.dataTransfer.files)) {
			if (file.type.startsWith("image/")) await processImageBlob(file);
			else await processFileBlob(file);
		}
	};

	return (
		<div className="shrink-0 p-0">
			<ContextPillBar
				sessionId={id}
				onWorkspaceClick={() => setWorkspacePickerOpen((v) => !v)}
				workspaceBtnRef={wsPillBtnRef}
				automationEar={automationEar}
			/>

			<div
				ref={cardRef}
				className={clsx(
					"composer-optical-card relative z-10 rounded-[22px] border transition-colors duration-150",
					isDraggingOver
						? "border-[var(--accent)]"
						: hasPromptError
							? "border-rose-500/50"
							: "border-[var(--composer-border,var(--border))]",
				)}
			>
				{workspacePickerOpen && (
					<WorkspacePickerPopover
						anchor={wsPillBtnRef.current ?? addBtnRef.current}
						ignoreRefs={workspacePickerIgnoreRefs}
						activeWorkspaceId={workspaceId}
						mode={workspaceMode}
						onSelectPath={onChangeCwd}
						onClose={() => setWorkspacePickerOpen(false)}
					/>
				)}

				<ComposerAttachmentStrip
					images={images}
					files={files}
					previewImageIndex={previewImageIndex}
					onOpenImage={setPreviewImageIndex}
					onClosePreview={() => setPreviewImageIndex(null)}
					onRemoveImage={removeImageByIndex}
					onRemoveFile={removeFileByIndex}
				/>

				{cameraOpen && (
					<PhoneCameraDialog
						onPhoto={(photo, isCurrent) =>
							insertImagePath(photo.path, photo.name, isCurrent)
						}
						onClose={() => {
							setCameraOpen(false);
							addBtnRef.current?.focus();
						}}
					/>
				)}

				{sketchOpen && (
					<Suspense fallback={null}>
						<SketchPad
							composerTop={cardRef.current?.getBoundingClientRect().top ?? null}
							onCancel={() => setSketchOpen(false)}
							onInsert={(d) => void handleInsertSketch(d)}
						/>
					</Suspense>
				)}

				{/* Textarea with mirrored inline image/file token highlighting */}
				<div className="relative w-full">
					{hasImageTokens && (
						<div
							ref={backdropRef}
							className={clsx(
								COMPOSER_TEXT_METRICS_CLASS,
								"pointer-events-none absolute inset-0 select-none overflow-hidden px-4 pt-3 pb-1.5 text-[var(--text)]",
							)}
							style={{
								...COMPOSER_TEXT_METRICS_STYLE,
								boxSizing: "border-box",
							}}
						>
							{renderHighlightedText(text, imageOpen)}
						</div>
					)}
					<textarea
						ref={taRef}
						data-composer={id}
						value={text}
						rows={1}
						placeholder={placeholder ?? t("composer.placeholderDefault")}
						onScroll={(e) => {
							const ta = e.currentTarget;
							if (ta.scrollLeft !== 0) ta.scrollLeft = 0;
							if (ta.style.overflowY !== "auto" && ta.scrollTop !== 0) {
								ta.scrollTop = 0;
							}
							if (backdropRef.current) {
								backdropRef.current.scrollTop = ta.scrollTop;
							}
						}}
						onChange={(e) => {
							const next = e.target.value;
							const caret = e.target.selectionStart ?? next.length;
							applySyncedText(next);
							setCursorPos(caret);
							setMenuDismissed(false);
						}}
						onSelect={(e) => {
							const ta = e.currentTarget;
							const pos = ta.selectionStart ?? 0;
							if (pos !== ta.selectionEnd) {
								setCursorPos(pos);
								return;
							}
							const token = tokenRanges.find((r) => r.start < pos && pos < r.end);
							if (token) {
								const snap =
									pos - token.start < token.end - pos ? token.start : token.end;
								ta.setSelectionRange(snap, snap);
								setCursorPos(snap);
							} else {
								setCursorPos(pos);
							}
						}}
						onKeyDown={onKeyDown}
						onDragOver={onDragOver}
						onDragLeave={onDragLeave}
						onDrop={(e) => void onDrop(e)}
						onPaste={(e) => void onPaste(e)}
						style={{
							outline: "none",
							boxShadow: "none",
							overflowX: "hidden",
							...COMPOSER_TEXT_METRICS_STYLE,
						}}
						className={clsx(
							COMPOSER_TEXT_METRICS_CLASS,
							"w-full resize-none overflow-x-hidden overflow-y-hidden overscroll-none bg-transparent px-4 pt-3 pb-1.5 outline-none !outline-none focus:outline-none focus:ring-0 placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap placeholder:text-[var(--text-30,var(--text-dim))]",
							hasImageTokens
								? "relative z-10 text-transparent caret-[var(--text)] selection:bg-sky-500/30 selection:text-transparent"
								: "relative text-[var(--text)]",
						)}
					/>
				</div>

				{/* Bottom toolbar */}
				<div className="@container">
					<div
						ref={toolbarRef}
						className={clsx(
							"flex flex-wrap items-center justify-between gap-y-1.5 px-2.5 pb-2 text-[12px]",
							toolbarTier >= TIER_TIGHT ? "gap-x-1" : "gap-x-2",
						)}
					>
						<div className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5">
							<button
								ref={addBtnRef}
								type="button"
								onClick={() => setAddMenuOpen((v) => !v)}
								aria-label={t("composer.addAria")}
								title={t("composer.addTitle")}
								className={clsx(
									"flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--ghost-hover,var(--bg-hover))] hover:text-[var(--text)]",
									addMenuOpen
										? "bg-[var(--ghost-hover,var(--bg-hover))] text-[var(--text)]"
										: "text-[var(--text-60,var(--text-muted))]",
								)}
							>
								<Plus size={15} />
							</button>
							{addMenuOpen && (
								<AddMenuPopover
									anchor={addBtnRef.current}
									ignoreRef={addBtnRef}
									onClose={() => setAddMenuOpen(false)}
									onAddFiles={() => void handleAddAttachment()}
									onPhoneCamera={() => setCameraOpen(true)}
									onPickProject={() => setWorkspacePickerOpen(true)}
									onSketch={() => setSketchOpen(true)}
								/>
							)}

							<ComposerModelControls
								pickerId={id}
								toolbarTier={toolbarTier}
								models={models}
								modelLabel={modelLabel}
								currentValue={currentModel.value}
								currentThinking={currentThinking}
								thinkingKind={thinkingKind}
								thinkingLevels={thinkingLevels}
								reasoning={currentModelOption?.reasoning}
								modelOpen={modelOpen}
								onModelOpenChange={setModelOpen}
								thinkingOpen={thinkingOpen}
								onThinkingOpenChange={setThinkingOpen}
								onEnsureModels={() => void useModelCatalog.getState().refresh()}
								onSelectModel={handleSelectModel}
								onSelectThinking={handleSelectThinking}
							/>
						</div>

						{trailingControls && (
							<div className="flex flex-wrap items-center justify-end gap-2">
								{trailingControls}
							</div>
						)}
					</div>
				</div>
			</div>

			<AtFileMenu
				anchor={cardRef.current}
				items={atMenu}
				activeIndex={menuIndex}
				onSelect={applyAtCompletion}
				onDismiss={dismissAtMenu}
			/>

			{slashToken && (
				<SlashMenu
					anchor={cardRef.current}
					sections={slashSections}
					activeIndex={Math.min(menuIndex, Math.max(0, slashItems.length - 1))}
					empty={slashItems.length === 0}
					onSelect={applySlashSkill}
					onDismiss={() => setMenuDismissed(true)}
				/>
			)}
		</div>
	);
}
