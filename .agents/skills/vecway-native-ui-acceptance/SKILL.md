---
name: vecway-native-ui-acceptance
description: Use when recovering a Vecway desktop white screen or accepting changes in an exact native development or bundled application window.
---

# Scope and driver

Verify the actual Vecway native product window. Browser fixtures, HTTP success, typechecks, and builds do not replace native acceptance. Use **agent-desktop only** for native GUI observation and operation. Read `skill://agent-desktop`, identify the installed binary/version, and consult its version-matched embedded guides for targeting, permissions, actions, screenshots, delivery/retry semantics, clipboard, and graceful closure. Do not copy a command manual here, guess APIs, or substitute another GUI driver.

# Preflight and ownership

Before a scenario or recovery action:

- Assign one GUI owner. Record the exact executable, PID, build/revision, worktree when applicable, native window identity, and ownership of app, fixture data, services, and listeners. Lock every operation to the exact instance/window using documented targeting. Do not touch another installed instance, credentials, unrelated sessions, or user data.
- Establish actual permission and target readiness, then observe the intended control and its supported semantic action. Use fresh qualified references on the active surface; reobserve after surface changes or stale references. Never infer focus, action delivery, or success from a submitted command alone.
- Verify scenario prerequisites early: task-owned fixture/session identity, discoverable skills/models, correct model/session metadata, and local RPC readiness when required. Valid configuration or a disk session does not prove a live connection; idle-suspended sessions may need the normal supported wake path. Use local readiness/handshake evidence, not a model inference request, to establish this prerequisite. Do not send inference merely for preflight.
- Distinguish development and bundled builds. Only a development build requires the exact configured dev URL and matching server listener. If absent, restore only its required UI server with existing dependencies and a uniquely named managed service; confirm the configured loopback family is reachable. Do not duplicate servers, install dependencies, change global networking, or restart the backend as a shortcut. A bundled app does not require Vite.
- Freeze the build/revision and relevant fixture, configuration, and runtime dependencies for acceptance. Let edits settle first. Preserve completed evidence; rerun only scenarios whose relevant dependencies changed, recording the reason. Do not rebuild or restart between scenarios without a bounded need and the required authorization.
- Check for macOS screen lock before interpreting black frames or failed foreground activation (locked sessions expose `loginwindow` in front and `IOConsoleLocked=Yes`); once the user reports unlocking, resume directly on the target window without re-questioning.

# Actions and evidence

- Default to silent semantic actions without foreground activation. Prefer documented semantic value-setting over keyboard entry. Verify each action with fresh state and, where needed, a matching exact-window screenshot. Inspect documented delivery/retry status before retrying; uncertain delivery requires observation, not blind repetition.
- Verify the intended input and actual focus before keyboard editing. A button activation is not proof of input focus. A failed shortcut or typing artifact is not automatically a product defect; distinguish delivery, focus, environment, and product behavior using observed evidence.
- Semantic activation proves semantic behavior, **not pointer reachability**. Pointer/overlap regressions require explicitly authorized headed input, a fresh grounded target using the installed guide's coordinate contract, and an observed result in the exact window. Never infer offsets or scaling. If authorization or a supported input path is unavailable, report the pointer acceptance gate as remaining; do not replace it with semantic success.
- Preserve clipboard privacy. Never log or expose the original contents. Use only the documented privacy-preserving capture/restore mechanism for synthetic paste tests; if safe restoration is unavailable, do not replace the clipboard. Restore it before handoff/exit and remove only owned temporary captures after successful restoration. Report restoration failure without revealing contents.
- Record observable checkpoints, exact target/build, actions, outcomes, and evidence locations. Separate observed, partial, and unobserved results. Retain passed evidence rather than repeating completed scenarios.

# Failure limits and handoff

After one documented method and one supported alternative fail, stop that path. If no supported alternative exists, stop without inventing one. Record the target/control, focus or action state, attempted methods, delivery/error results, and available screenshots/state. Classify the blocker as tool, environment, product, or unresolved with the evidence for that classification; do not guess its cause. Report a bounded next decision and any required authorization. Continue independent scenarios without silently reducing acceptance or looping on failed inputs. Report the first completed scenario or concrete blocker promptly.

Changing GUI owner requires explicit pause/release acknowledgment before the replacement starts. Transfer the existing exact window/runtime, ownership boundaries, current state, completed evidence, remaining gates, and clipboard-restoration responsibility. Do not create duplicate runtimes.

# Narrow white-screen recovery

1. Complete preflight and identify whether startup depends on a dev server or bundled resources. Do not assume a historical reason for a stopped server or an empty page.
2. Use an observed, supported native Reload control if appropriate and verify its result. A shortcut's delivery is not proof of a bound reload action; a source/HTML change cannot refresh a page whose development client never loaded. Do not repeatedly refresh an unchanged failure.
3. Inspect startup resource errors and the current main document through the existing native Inspector, using agent-desktop. Allow supported delayed docking/AX mapping without repeated blind actions. Do not inspect storage, credentials, or unrelated sessions, and do not infer React failure from an empty document.
4. Only for a confirmed startup-navigation failure, separately authorized fixed navigation through the existing Inspector to the **exact configured local entry** may be narrower than restarting the backend. Confirm the target main document and exact input before execution. No arbitrary scripts, debug injection, or product fallback changes; any different intervention requires its own explicitly authorized, bounded scenario. If unavailable, report evidence and the next bounded decision rather than improvising.
5. Recovery passes only when fresh observation of the exact native product window shows real application controls and ready state, with the Inspector closed. An empty/white capture is not a pass and does not by itself establish an off-screen, lock-screen, driver, or product cause.

# Cleanup and delivery

Close only task-owned inspection surfaces and task-owned app instances, using the installed agent-desktop guide's official graceful close operation. Never use force, signals, quit shortcuts, or process-tree termination. Leave user apps, shared automation services, and unrelated/backend sessions untouched. If graceful closure fails, report the remaining owned instance; do not escalate. Keep a restored managed UI server when the existing app requires it and report its exact ownership and documented lifecycle/stop route without stopping shared services.

Report observed recovery, native scenario results, retained evidence, exact build/instance, code/data/process boundaries, cleanup and clipboard status, and remaining acceptance gates or unknown causes. Never claim live UI verification from fixtures or semantic pointer evidence. Do not run unrelated checks, GUI scenarios, builds, formatters, or commits merely because this skill was edited.
