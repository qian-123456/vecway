import { useSyncExternalStore } from "react";
import { isKeyboardOpenNow, subscribeKeyboardOpen } from "../../../app/viewport";

/**
 * Subscribes to the unified viewport/keyboard state from `app/viewport.ts`.
 * Never treats bare textarea focus as keyboard open.
 */
export function useKeyboardOpen(): boolean {
	return useSyncExternalStore(subscribeKeyboardOpen, isKeyboardOpenNow, () => false);
}
