export interface DisabledReason {
	kind: string;
	key?: string;
	pattern?: string;
	exact?: boolean;
}

export interface Skill {
	name: string;
	description: string;
	source: string;
	provider: string;
	path: string;
	dir: string;
	root: string;
	copies: number;
	issues: string[];
	promptChars: number;
	enabled: boolean;
	disabledReason: DisabledReason | null;
}

export interface Extension {
	name: string;
	path: string;
	source: string;
	enabled: boolean;
}

export interface SkillsData {
	skills: Skill[];
	extensions: Extension[];
	skillsEnabled: boolean;
	configError: string | null;
}

export const ISSUE_LABEL: Record<string, string> = {
	missing_description: "缺少描述",
	description_too_long: "描述超过 1024 字符",
	unreadable: "SKILL.md 无法读取",
	missing_skill_md: "目录缺少 SKILL.md",
};

export function reasonText(r: DisabledReason | null | undefined): string {
	if (!r) return "";
	switch (r.kind) {
		case "all_off":
			return "技能功能已整体关闭";
		case "disabled":
			return "已手动停用";
		case "source":
			return "该来源已在设置中整体关闭";
		case "ignored":
			return r.exact ? "已被忽略规则排除" : `已被忽略规则排除${r.pattern ? `（${r.pattern}）` : ""}`;
		case "not_included":
			return "不在允许列表中";
	}
	return r.kind;
}

/** Every whitespace-separated term must appear in name, description, provider or source. */
export function filterSkills(skills: Skill[], query: string): Skill[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return skills;
	return skills.filter((s) => {
		const hay = `${s.name} ${s.description} ${s.provider} ${s.source}`.toLowerCase();
		return terms.every((t) => hay.includes(t));
	});
}

/** Drop YAML frontmatter from a SKILL.md so the detail view renders only the body. */
export function stripFrontmatter(text: string): string {
	const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	return m ? text.slice(m[0].length).replace(/^\s+/, "") : text;
}
