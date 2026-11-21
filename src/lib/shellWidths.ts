import {
	MIN_CENTER_WIDTH,
	MIN_RIGHT_WIDTH,
	MIN_SIDEBAR_WIDTH,
} from "../stores/ui";

export interface ShellWidthsInput {
	viewportWidth: number;
	sidebarOpen: boolean;
	sidebarWidth: number;
	rightVisible: boolean;
	rightWidth: number;
}

export interface ShellWidths {
	leftWidth: number;
	rightWidth: number;
}

/**
 * Compute rendered left/right panel widths that always fit inside `viewportWidth`
 * while preserving `MIN_CENTER_WIDTH` whenever possible. Persisted preferences are
 * left untouched so widening the window restores the user's chosen widths.
 */
export function computeShellWidths({
	viewportWidth,
	sidebarOpen,
	sidebarWidth,
	rightVisible,
	rightWidth,
}: ShellWidthsInput): ShellWidths {
	const leftPref = sidebarOpen ? Math.max(MIN_SIDEBAR_WIDTH, sidebarWidth) : 0;
	const rightPref = rightVisible ? Math.max(MIN_RIGHT_WIDTH, rightWidth) : 0;

	if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
		return { leftWidth: leftPref, rightWidth: rightPref };
	}

	if (!sidebarOpen && !rightVisible) {
		return { leftWidth: 0, rightWidth: 0 };
	}

	const leftFloor = sidebarOpen ? MIN_SIDEBAR_WIDTH : 0;
	const rightFloor = rightVisible ? MIN_RIGHT_WIDTH : 0;
	const availableForSides = viewportWidth - MIN_CENTER_WIDTH;

	if (leftPref + rightPref <= availableForSides) {
		return { leftWidth: leftPref, rightWidth: rightPref };
	}

	// If both floors + MIN_CENTER_WIDTH fit, trim only the excess above each floor.
	if (availableForSides >= leftFloor + rightFloor) {
		const budgetAboveFloors = availableForSides - leftFloor - rightFloor;
		const leftExcess = leftPref - leftFloor;
		const rightExcess = rightPref - rightFloor;
		const totalExcess = leftExcess + rightExcess;
		if (totalExcess <= 0) {
			return { leftWidth: leftFloor, rightWidth: rightFloor };
		}
		const leftAdd = Math.floor((budgetAboveFloors * leftExcess) / totalExcess);
		const rightAdd = budgetAboveFloors - leftAdd;
		return {
			leftWidth: leftFloor + leftAdd,
			rightWidth: rightFloor + rightAdd,
		};
	}

	// Extreme narrow viewport (e.g. high zoom): keep all open panes visible inside
	// the viewport by scaling side floors and center together so nothing clips off-screen.
	const totalFloors = leftFloor + rightFloor + MIN_CENTER_WIDTH;
	const scale = viewportWidth / totalFloors;
	return {
		leftWidth: sidebarOpen ? Math.max(120, Math.floor(leftFloor * scale)) : 0,
		rightWidth: rightVisible ? Math.max(120, Math.floor(rightFloor * scale)) : 0,
	};
}
