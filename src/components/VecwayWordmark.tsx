import clsx from "clsx";
import { useId, useLayoutEffect, useRef, useState } from "react";

interface VecwayWordmarkProps {
	height?: number;
	className?: string;
}

/**
 * Adaptive Vecway brand lockup: replaces the capital "V" with the two-tone
 * geometric wrench mark (~2.1x lowercase x-height) and uses an SVG mask so the
 * pivot pinhole remains genuinely transparent over any theme surface.
 */
export function VecwayWordmark({ height = 21, className }: VecwayWordmarkProps) {
	const rawId = useId();
	const maskId = `vecway-pinhole-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const groupRef = useRef<SVGGElement>(null);
	const [viewBox, setViewBox] = useState("109 94 1060 364");

	useLayoutEffect(() => {
		const g = groupRef.current;
		if (!g || typeof g.getBBox !== "function") return;
		try {
			const b = g.getBBox();
			if (b.width > 0 && b.height > 0) {
				// SVG getBBox() excludes strokeWidth; include the 54px round stroke cap
				// on M144.2 137.9 -> L252 392 (radius 27) so the left arm is never clipped.
				const minX = Math.min(b.x, 144.2 - 27);
				const minY = Math.min(b.y, 137.9 - 27);
				const maxX = Math.max(b.x + b.width, 412);
				const maxY = Math.max(b.y + b.height, 392 + 27);
				const pad = 8;
				setViewBox(
					`${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${(maxX - minX + pad * 2).toFixed(1)} ${(maxY - minY + pad * 2).toFixed(1)}`,
				);
			}
		} catch {
			// Ignore non-browser / jsdom SVG bbox unavailability
		}
	}, []);

	return (
		<svg
			viewBox={viewBox}
			style={{ height: `${height}px`, width: "auto" }}
			fill="none"
			role="img"
			aria-label="Vecway"
			className={clsx("block shrink-0 select-none", className)}
		>
			<defs>
				<mask id={maskId}>
					<rect x="0" y="0" width="2200" height="800" fill="white" />
					<circle cx="252" cy="392" r="17" fill="black" />
				</mask>
			</defs>
			<g ref={groupRef}>
				<g mask={`url(#${maskId})`}>
					<path
						d="M144.2 137.9 L252 392"
						stroke="var(--text-40, var(--text-muted))"
						strokeWidth="54"
						strokeLinecap="round"
					/>
					<path
						d="M 226.6 382.7 L 302.4 219.3 C 268.8 177.6, 275.1 135.9, 306.7 113.3 C 319.9 103.2, 334.6 100.5, 346.6 104 L 321 159.8 L 360 186.6 L 402.9 142.7 C 410.4 152.7, 413.1 167.3, 408.5 183.3 C 398.7 220.9, 362 241.7, 337.1 237.5 L 276.5 403.4 A 27 27 0 0 1 226.6 382.7 Z"
						fill="var(--text)"
					/>
				</g>
				<text
					x="342"
					y="406"
					fill="var(--text)"
					fontSize="284"
					fontWeight="600"
					letterSpacing="-7"
					style={{ fontFamily: "var(--font-sans)" }}
				>
					ecway
				</text>
			</g>
		</svg>
	);
}
