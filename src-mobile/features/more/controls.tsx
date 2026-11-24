import { CircleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../core/api";
import { Button, EmptyState, Spinner } from "../../ui";

/** Loads data on mount; `reload` refetches without clearing existing data (pull-to-refresh friendly). */
export function useLoad<T>(fn: () => Promise<T>, deps: ReadonlyArray<unknown> = []) {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const fnRef = useRef(fn);
	fnRef.current = fn;
	const seq = useRef(0);
	const reload = useCallback(async () => {
		const mine = ++seq.current;
		try {
			const v = await fnRef.current();
			if (mine !== seq.current) return;
			setData(v);
			setError(null);
		} catch (e) {
			if (mine === seq.current) setError(errorMessage(e, "加载失败"));
		} finally {
			if (mine === seq.current) setLoading(false);
		}
	}, []);
	useEffect(() => {
		setLoading(true);
		void reload();
		return () => {
			seq.current++;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);
	return { data, setData, error, loading, reload };
}

/** Full-page body states: loading spinner / error with retry. */
export function LoadState({ loading, error, onRetry }: { loading: boolean; error: string | null; onRetry: () => void }) {
	if (loading)
		return (
			<div className="flex flex-1 items-center justify-center py-20 text-m-text-3">
				<Spinner size={22} />
			</div>
		);
	if (error)
		return (
			<EmptyState
				icon={<CircleAlert size={26} strokeWidth={1.75} />}
				title="加载失败"
				hint={<span className="m-selectable">{error}</span>}
				action={<Button onClick={onRetry}>重试</Button>}
			/>
		);
	return null;
}
