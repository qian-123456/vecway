import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { PageProps, RouteName } from "../core/nav";

type Page = LazyExoticComponent<ComponentType<PageProps>>;

/**
 * Lazy route table. Every page is imported directly from its own module so each route stays an
 * isolated chunk without pulling sibling pages from feature barrels.
 */
export const ROUTES: Record<Exclude<RouteName, "notFound">, Page> = {
	home: lazy(() => import("../features/sessions/HomePage").then((m) => ({ default: m.HomePage }))),
	chat: lazy(() => import("../features/chat/ChatPage").then((m) => ({ default: m.ChatPage }))),
	subagents: lazy(() => import("../features/subagents/SubagentsPage").then((m) => ({ default: m.SubagentsPage }))),
	subagent: lazy(() => import("../features/subagents/SubagentDetailPage").then((m) => ({ default: m.SubagentDetailPage }))),
	files: lazy(() => import("../features/panels/FilesPage").then((m) => ({ default: m.FilesPage }))),
	git: lazy(() => import("../features/panels/GitPage").then((m) => ({ default: m.GitPage }))),
	terminal: lazy(() => import("../features/panels/TerminalPage").then((m) => ({ default: m.TerminalPage }))),
	plan: lazy(() => import("../features/panels/PlanPage").then((m) => ({ default: m.PlanPage }))),
	sidechat: lazy(() => import("../features/panels/SidechatPage").then((m) => ({ default: m.SidechatPage }))),
	services: lazy(() => import("../features/panels/ServicesPage").then((m) => ({ default: m.ServicesPage }))),
	inbox: lazy(() => import("../features/sessions/InboxPage").then((m) => ({ default: m.InboxPage }))),
	search: lazy(() => import("../features/sessions/SearchPage").then((m) => ({ default: m.SearchPage }))),
	schedules: lazy(() => import("../features/more/SchedulesPage").then((m) => ({ default: m.SchedulesPage }))),
	scheduleNew: lazy(() => import("../features/more/ScheduleFormPage").then((m) => ({ default: m.ScheduleNewPage }))),
	schedule: lazy(() => import("../features/more/ScheduleFormPage").then((m) => ({ default: m.ScheduleDetailPage }))),
	scheduleRuns: lazy(() => import("../features/more/ScheduleRunsPage").then((m) => ({ default: m.ScheduleRunsPage }))),
	skills: lazy(() => import("../features/more/SkillsPage").then((m) => ({ default: m.SkillsPage }))),
	ideas: lazy(() => import("../features/more/IdeasPage").then((m) => ({ default: m.IdeasPage }))),
	settings: lazy(() => import("../features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage }))),
	settingsRoles: lazy(() => import("../features/settings/models/RolesPage").then((m) => ({ default: m.SettingsRolesPage }))),
	settingsProviders: lazy(() => import("../features/settings/models/ProvidersPage").then((m) => ({ default: m.SettingsProvidersPage }))),
	settingsFallbacks: lazy(() => import("../features/settings/models/FallbacksPage").then((m) => ({ default: m.SettingsFallbacksPage }))),
	settingsContext: lazy(() => import("../features/settings/models/ContextPage").then((m) => ({ default: m.SettingsContextPage }))),
	quota: lazy(() => import("../features/settings/QuotaPage").then((m) => ({ default: m.QuotaPage }))),
};
