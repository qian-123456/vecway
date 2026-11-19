/**
 * Default & user-customizable prompt templates for automation testing and AI adjustment.
 * Templates support the `{{name}}` placeholder and can be customized in Settings -> Automations.
 */
import type { Settings } from "../../lib/contracts";
import type { Locale } from "../../lib/i18n";

export type AutomationPromptKey = "mockTest" | "realOnceTest" | "realLoopTest" | "adjust";

export const DEFAULT_AUTOMATION_PROMPTS: Record<Locale, Record<AutomationPromptKey, string>> = {
	"zh-CN": {
		mockTest:
			"帮我在模拟环境下测试「{{name}}」，用模拟数据验证整个流程，不改动真实环境。遇到问题在不改变我原意的前提下自行修复并复测，稳定通过后更新确认卡并展示预期汇报效果；需要我做取舍或多次修复仍过不了时再停下来说明。",
		realOnceTest:
			"帮我在真实环境下测试「{{name}}」，实际执行一轮验证效果。成功的话汇报真实结果；如果遇到异常或卡住，立刻停止并说明原因，不要盲目重试，给出下一步修复建议。",
		realLoopTest:
			"帮我在真实环境下测试「{{name}}」。通过后汇报实际结果并按需更新确认卡；遇到问题时定位原因并修复复测直到稳定，涉及高风险或不可逆操作、或需要我做决策时再先停下来确认。",
		adjust: "我对「{{name}}」方案还想调整：",
	},
	"en-US": {
		mockTest:
			'Test "{{name}}" in a safe mock environment using simulated data without modifying the real environment. If anything fails or stalls, fix and re-test while preserving my intent until it passes reliably, then update the confirmation card and show the expected report; stop and explain if a product trade-off is needed or repeated fixes still fail.',
		realOnceTest:
			'Run one real-environment test pass for "{{name}}" to verify actual behavior. Report the real observed result if it succeeds; if an error or block occurs, stop immediately without retrying blindly, explain the cause, and suggest next steps.',
		realLoopTest:
			'Test "{{name}}" in the real environment. Report the real result and update the confirmation card once stable; if issues occur, diagnose, fix, and re-test until reliable, pausing first for confirmation before any high-risk/irreversible action or decision.',
		adjust: 'I want to adjust the "{{name}}" automation: ',
	},
};

const SETTINGS_FIELD_MAP: Record<AutomationPromptKey, keyof Settings> = {
	mockTest: "automationPromptMockTest",
	realOnceTest: "automationPromptRealOnceTest",
	realLoopTest: "automationPromptRealLoopTest",
	adjust: "automationPromptAdjust",
};

export function getAutomationPromptTemplate(
	key: AutomationPromptKey,
	settings: Settings | null | undefined,
	locale: Locale,
): string {
	const field = SETTINGS_FIELD_MAP[key];
	const custom = settings?.[field];
	if (typeof custom === "string" && custom.trim()) {
		return custom;
	}
	return DEFAULT_AUTOMATION_PROMPTS[locale][key];
}

export function renderAutomationPrompt(
	key: AutomationPromptKey,
	name: string,
	settings: Settings | null | undefined,
	locale: Locale,
): string {
	const template = getAutomationPromptTemplate(key, settings, locale);
	return template.replace(/\{\{\s*name\s*\}\}/g, name.trim() || (locale === "zh-CN" ? "未命名自动化" : "Untitled automation"));
}
