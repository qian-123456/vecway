import { create } from "zustand";
import { DEFAULT_SEARCH_FILTERS, type SearchFilters } from "./searchModel";

interface SearchDialogState {
	open: boolean;
	/** Bumped on every open request (⌘F while open too) so the input re-focuses. */
	focusSeq: number;
	/** Persisted query and filter state across dialog reopens. */
	query: string;
	filters: SearchFilters;
	openDialog: () => void;
	closeDialog: () => void;
	setQuery: (query: string) => void;
	setFilters: (next: SearchFilters | ((prev: SearchFilters) => SearchFilters)) => void;
}

export const useSearchDialog = create<SearchDialogState>((set) => ({
	open: false,
	focusSeq: 0,
	query: "",
	filters: DEFAULT_SEARCH_FILTERS,
	openDialog: () => set((s) => ({ open: true, focusSeq: s.focusSeq + 1 })),
	closeDialog: () => set({ open: false }),
	setQuery: (query) => set({ query }),
	setFilters: (next) =>
		set((s) => ({
			filters: typeof next === "function" ? next(s.filters) : next,
		})),
}));
