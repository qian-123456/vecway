import { useId } from "react";

/**
 * Vecway brand mark: monochrome wrench-V emblem (BW1) in a dark obsidian squircle.
 */
export function AppMark({ size = 32, className = "" }: { size?: number; className?: string }) {
	const id = useId();
	return (
		<svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-hidden className={`shrink-0 ${className}`}>
			<defs>
				<linearGradient id={`${id}-bg`} x1="64" y1="24" x2="448" y2="488" gradientUnits="userSpaceOnUse">
					<stop offset="0%" stopColor="#141417" />
					<stop offset="100%" stopColor="#09090B" />
				</linearGradient>
				<linearGradient id={`${id}-left`} x1="144.2" y1="110.9" x2="252" y2="419" gradientUnits="userSpaceOnUse">
					<stop offset="0%" stopColor="#A1A1AA" />
					<stop offset="100%" stopColor="#52525B" />
				</linearGradient>
				<linearGradient id={`${id}-right`} x1="402.9" y1="104" x2="252" y2="419" gradientUnits="userSpaceOnUse">
					<stop offset="0%" stopColor="#FFFFFF" />
					<stop offset="100%" stopColor="#D4D4D8" />
				</linearGradient>
			</defs>
			<rect x="24" y="24" width="464" height="464" rx="108" fill={`url(#${id}-bg)`} stroke="#27272A" strokeWidth="8" />
			<path d="M144.2 137.9 L252 392" stroke={`url(#${id}-left)`} strokeWidth="54" strokeLinecap="round" />
			<path
				d="M 226.6 382.7 L 302.4 219.3 C 268.8 177.6, 275.1 135.9, 306.7 113.3 C 319.9 103.2, 334.6 100.5, 346.6 104 L 321 159.8 L 360 186.6 L 402.9 142.7 C 410.4 152.7, 413.1 167.3, 408.5 183.3 C 398.7 220.9, 362 241.7, 337.1 237.5 L 276.5 403.4 A 27 27 0 0 1 226.6 382.7 Z"
				fill={`url(#${id}-right)`}
			/>
			<circle cx="252" cy="392" r="16" fill="#090B0E" />
		</svg>
	);
}
