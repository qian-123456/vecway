/** [B] Textarea that grows with its content up to `maxHeightPx`, then scrolls. */

import { type CSSProperties, type TextareaHTMLAttributes, useLayoutEffect, useRef } from "react";

const SUPPORTS_FIELD_SIZING =
	typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");

export function AutoGrowTextarea({
	value,
	maxHeightPx = 480,
	className,
	style,
	...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "rows"> & {
	value: string;
	maxHeightPx?: number;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every value change
	useLayoutEffect(() => {
		if (SUPPORTS_FIELD_SIZING) return;
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, maxHeightPx)}px`;
		el.style.overflowY = el.scrollHeight > maxHeightPx ? "auto" : "hidden";
	}, [value, maxHeightPx]);
	const mergedStyle: CSSProperties | undefined = SUPPORTS_FIELD_SIZING
		? { ...style, fieldSizing: "content", maxHeight: `${maxHeightPx}px`, overflowY: "auto" }
		: style;
	return (
		<textarea
			{...rest}
			ref={ref}
			rows={1}
			value={value}
			style={mergedStyle}
			className={className}
		/>
	);
}
