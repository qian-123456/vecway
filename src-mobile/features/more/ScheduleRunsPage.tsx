import type { PageProps } from "../../core/nav";
import { PageHeader } from "../../ui";
import { AutomationOverviewView } from "./AutomationOverviewView";
import { useMobileSchedules } from "../../core/stores/schedules";

/**
 * Legacy `/schedules/:id/runs` deep-link route: renders the unified Overview view
 * directly (retaining full awaiting-run recovery and history compatibility).
 */
export function ScheduleRunsPage({ route }: PageProps) {
	const id = route.params.id ?? "";
	const name = useMobileSchedules((s) => s.schedules.find((x) => x.id === id)?.name);
	return (
		<div className="flex h-full min-h-0 flex-col bg-m-bg-elev text-m-text">
			<PageHeader title="运行记录" subtitle={name} className="bg-m-bg-elev!" />
			<AutomationOverviewView id={id} />
		</div>
	);
}
