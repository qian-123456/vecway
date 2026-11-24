import { Cpu } from "lucide-react";
import { useRef, useState } from "react";
import { api, errorMessage } from "../../../core/api";
import { ListGroup, ListRow, SelectRow, toast } from "../../../ui";
import { SettingsSheet } from "../rows";
import {
	APPROVAL_MODES,
	approvalEffect,
	AUTOMATION_OVERLAP_POLICIES,
	isAutomationOverlapPolicy,
	type ApprovalMode,
	type AutomationOverlapPolicy,
} from "../settingsMap";

const SOURCE_LABEL: Record<string, string> = {
	"modelRoles.default": "来自模型角色「全局默认」",
	newSessionModel: "来自新会话默认模型",
};

export function GeneralSheet({
	open,
	onClose,
	mode,
	defaultModel,
	defaultModelSource,
	onModeChange,
	automationOverlapPolicy,
	onAutomationOverlapPolicyChange,
}: {
	open: boolean;
	onClose: () => void;
	mode: ApprovalMode | null;
	defaultModel?: string | null;
	defaultModelSource?: string | null;
	onModeChange: (m: ApprovalMode) => void;
	automationOverlapPolicy: AutomationOverlapPolicy | null;
	onAutomationOverlapPolicyChange: (policy: AutomationOverlapPolicy) => void;
}) {
	const [busy, setBusy] = useState(false);
	const overlapSaving = useRef(false);
	const [overlapBusy, setOverlapBusy] = useState(false);
	const [overlapError, setOverlapError] = useState<string | null>(null);

	const choose = async (next: ApprovalMode) => {
		if (busy) return;
		setBusy(true);
		try {
			const r = await api<{ defaultApprovalMode?: ApprovalMode }>("POST", "/left/settings/approval-mode", { mode: next });
			onModeChange(r.defaultApprovalMode ?? next);
			toast("审批模式已更新，对之后新开的会话生效", { kind: "success" });
		} catch (e) {
			toast(`保存失败：${errorMessage(e)}`, { kind: "error" });
		} finally {
			setBusy(false);
		}
	};

	const chooseOverlapPolicy = async (next: AutomationOverlapPolicy) => {
		if (overlapSaving.current || automationOverlapPolicy == null) return;
		overlapSaving.current = true;
		setOverlapBusy(true);
		setOverlapError(null);
		try {
			const result = await api<{ ok?: boolean; key?: string; value?: unknown }>("POST", "/left/settings/set", {
				key: "automationOverlapPolicy",
				value: next,
			});
			if (result.ok !== true || result.key !== "automationOverlapPolicy" || !isAutomationOverlapPolicy(result.value)) {
				throw new Error("电脑未返回有效的自动化重合策略，请刷新设置后重试。");
			}
			onAutomationOverlapPolicyChange(result.value);
			toast("重合策略已更新，对所有自动化的后续触发生效", { kind: "success" });
		} catch (e) {
			const message = errorMessage(e);
			setOverlapError(message);
			toast(`保存失败：${message}`, { kind: "error" });
		} finally {
			overlapSaving.current = false;
			setOverlapBusy(false);
		}
	};

	const approvalOptions = APPROVAL_MODES.map((o) => ({
		value: o.value,
		label: o.label,
		hint: approvalEffect(o.value),
	}));
	const overlapOptions = AUTOMATION_OVERLAP_POLICIES.map((o) => ({
		value: o.value,
		label: o.label,
		hint: o.effect,
	}));

	return (
		<SettingsSheet open={open} onClose={onClose} title="通用设置">
			<ListGroup title="审批" note="已经在运行的会话保持原来的模式，新开的会话使用这里的选择。">
				<SelectRow
					title="审批权限模式"
					subtitle={mode ? approvalEffect(mode) : "正在读取当前模式"}
					presentation="menu"
					value={mode}
					disabled={busy || mode == null}
					options={approvalOptions}
					onChange={(v) => void choose(v)}
				/>
			</ListGroup>
			<ListGroup title="自动化" note="对所有自动化的后续触发立即生效，不中断当前运行；已接收的排队任务会保留并依次执行。">
				<SelectRow
					title="运行重合策略"
					subtitle={AUTOMATION_OVERLAP_POLICIES.find((policy) => policy.value === automationOverlapPolicy)?.effect}
					presentation="menu"
					value={automationOverlapPolicy}
					disabled={overlapBusy || automationOverlapPolicy == null}
					options={overlapOptions}
					onChange={(value) => void chooseOverlapPolicy(value)}
					error={
						<>
							{automationOverlapPolicy == null && (
								<div role="alert" className="m-selectable text-m-sm text-m-danger">
									无法读取自动化重合策略，请返回设置后下拉刷新。
								</div>
							)}
							{overlapError && (
								<div role="alert" className="m-selectable whitespace-pre-wrap break-words text-m-sm text-m-danger">
									保存失败：{overlapError}
								</div>
							)}
						</>
					}
				/>
			</ListGroup>
			<ListGroup title="新会话" note="要换默认模型，去「模型角色」里修改「全局默认」。">
				<ListRow
					icon={<Cpu size={22} strokeWidth={1.75} />}
					title="默认模型"
					subtitle={
						<>
							<span className="m-selectable block font-m-mono break-all text-m-text-2">{defaultModel || "使用 OMP 内置推荐"}</span>
							{defaultModelSource && <span className="block">{SOURCE_LABEL[defaultModelSource] ?? `来源：${defaultModelSource}`}</span>}
						</>
					}
				/>
			</ListGroup>
		</SettingsSheet>
	);
}
