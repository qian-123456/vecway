import XCTest

final class VecwayMobileAcceptanceUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    func testHomeMenuSettingsChatWorkspaceAndSidechatParity() throws {
        // Wait for bundled WKWebView content to hydrate and connect to host.
        let menuButton = try waitForElement(label: "菜单", timeout: 20)
        _ = try waitForElement(label: "工作区", timeout: 15)
        capture("01-home")

        // 1. Open left navigation menu sheet and verify Settings page.
        tapSafely(menuButton)
        let settingsEntry = try waitForElement(labelContaining: "设置", timeout: 10)
        capture("02-menu-sheet")
        tapSafely(settingsEntry)
        _ = try waitForElement(labelContaining: "外观", timeout: 10)
        capture("03-settings")

        // Navigate back to Home/Chat from Settings.
        if let backButton = findElement(label: "返回") ?? findElement(label: "关闭") {
            tapSafely(backButton)
        } else {
            // Fallback: tap menu/close if present
            XCTFail("Expected back button on Settings page")
        }

        // 2. Open an existing recent conversation or stay on main chat view.
        if let recentChat = findFirstElement(labelsContaining: ["分钟前", "小时前", "刚刚", "排查 200k", "iOS 界面"]) {
            tapSafely(recentChat)
            Thread.sleep(forTimeInterval: 1.5)
        }
        _ = try waitForElement(label: "添加", timeout: 10)
        _ = try waitForElement(label: "发送", timeout: 10)
        capture("04-chat-main")

        // 3. Open model/thinking sheet from composer or header to inspect two-pane picker.
        if let modelTrigger = findElement(labelContaining: "模型：") ?? findElement(labelContaining: "gemini") {
            tapSafely(modelTrigger)
            _ = try waitForElement(labelContaining: "模型供应商", timeout: 8)
            capture("05-model-sheet")
            if let closeSheet = findElement(label: "关闭") {
                tapSafely(closeSheet)
            } else {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
            }
            Thread.sleep(forTimeInterval: 0.6)
        }

        // 4. Open Right Workspace Drawer and verify Git / Sidechat tabs + Plan is NOT in drawer + Row 1 switcher.
        let workspaceButton = try waitForElement(label: "工作区", timeout: 10)
        tapSafely(workspaceButton)
        _ = try waitForElement(label: "返回对话", timeout: 10)
        XCTAssertNil(findElement(label: "计划"), "Plan tab must not live inside RightWorkspaceDrawer")
        capture("06-drawer-default")

        // Switch to Git tab
        if let gitTab = findElement(label: "Git") {
            tapSafely(gitTab)
            Thread.sleep(forTimeInterval: 1.2)
            capture("07-drawer-git")
        }

        // Switch to Sidechat tab and verify Row 1 top switcher + settings parity.
        let sidechatTab = try waitForElement(label: "辅助对话", timeout: 10)
        tapSafely(sidechatTab)
        Thread.sleep(forTimeInterval: 1.5)
        capture("09-drawer-sidechat")

        // Verify Row 1 Sidechat switcher exists in top bar (non-capsule centered title button).
        let topSwitcher = try waitForElement(labelContaining: "切换辅助对话", timeout: 10)
        tapSafely(topSwitcher)
        _ = try waitForElement(label: "关闭切换", timeout: 8)
        capture("10-sidechat-switcher")
        if let closeSwitcher = findElement(label: "关闭切换") {
            tapSafely(closeSwitcher)
            Thread.sleep(forTimeInterval: 0.5)
        }

        // Open top-right "更多操作" menu inside Sidechat drawer and check rename action.
        if let moreButton = findElement(label: "更多操作") {
            tapSafely(moreButton)
            Thread.sleep(forTimeInterval: 0.6)
            capture("11-sidechat-more-menu")
            if let closeMore = findElement(label: "关闭") {
                tapSafely(closeMore)
            } else {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
            }
            Thread.sleep(forTimeInterval: 0.5)
        }

        // Verify Sidechat composer settings parity: model trigger and context usage trigger.
        if let sidechatModel = findFirstElement(labelsContaining: ["模型：", "切换模型"]) {
            tapSafely(sidechatModel)
            Thread.sleep(forTimeInterval: 0.8)
            capture("12-sidechat-model-sheet")
            if let closeModal = findElement(label: "关闭") {
                tapSafely(closeModal)
            } else {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
            }
            Thread.sleep(forTimeInterval: 0.5)
        }

        if let sidechatContext = findElement(labelContaining: "上下文用量") {
            tapSafely(sidechatContext)
            Thread.sleep(forTimeInterval: 0.8)
            capture("13-sidechat-context-sheet")
            if let closeContext = findElement(label: "关闭") {
                tapSafely(closeContext)
            } else {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
            }
            Thread.sleep(forTimeInterval: 0.4)
        }

        // Return to main chat from drawer.
        let returnChat = try waitForElement(label: "返回对话", timeout: 8)
        tapSafely(returnChat)
        Thread.sleep(forTimeInterval: 0.8)
        capture("14-returned-to-chat")
    }

    func testLiveMagpieHy4FlashPlanAndSidechatThread() throws {
        _ = try waitForElement(label: "菜单", timeout: 20)
        _ = try waitForElement(label: "工作区", timeout: 15)

        // 1. Pick magpie's hy4flash (free) model on Home composer
        let homeModelBtn = try waitForFirstElement(labelsContaining: ["模型：", "gemini-", "hy4", "claude", "gpt"], timeout: 10)
        tapSafely(homeModelBtn)
        let searchBox = try waitForElement(label: "搜索模型", timeout: 12)
        tapAndType(searchBox, text: "magpie hy4")
        Thread.sleep(forTimeInterval: 1.0)
        capture("live-01-model-search")

        let freeRow = try waitForFirstElement(labelsContaining: ["free", "hy4flash"], timeout: 8)
        tapSafely(freeRow)
        Thread.sleep(forTimeInterval: 0.8)
        if let doneBtn = findElement(label: "完成") ?? findElement(label: "关闭") {
            tapSafely(doneBtn)
        }
        Thread.sleep(forTimeInterval: 0.6)
        capture("live-02-home-model-selected")

        // 2. Enable 规划模式 directly on Home before sending first prompt (regression test for 会话不存在)
        tapSafely(try waitForElement(label: "添加", timeout: 8))
        let planSwitch = app.switches["规划模式"]
        XCTAssertTrue(planSwitch.waitForExistence(timeout: 8), "Expected 规划模式 switch")
        tapSafely(planSwitch)
        Thread.sleep(forTimeInterval: 0.6)
        capture("live-03-home-plan-mode-on")
        if let closeSheet = findElement(label: "关闭") {
            tapSafely(closeSheet)
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        }
        Thread.sleep(forTimeInterval: 0.5)

        let homeInput = try waitForElement(label: "消息输入框", timeout: 8)
        tapAndType(homeInput, text: "只调用写入计划文件或提交计划工具，给出包含「目标」和「步骤」两小节的极简计划，禁止修改任何仓库代码或执行命令。")
        tapSafely(try waitForElement(label: "发送", timeout: 8))

        Thread.sleep(forTimeInterval: 3.0)
        let planDeadline = Date().addingTimeInterval(45)
        while Date() < planDeadline {
            XCTAssertNil(findElement(labelContaining: "会话不存在"), "Must never hit 会话不存在 after enabling plan mode on Home")
            if findElement(label: "关闭计划") != nil || findElement(label: "方案目录") != nil {
                break
            }
            if findElement(label: "停止") == nil && findElement(label: "思考中") == nil && findElement(label: "发送") != nil {
                Thread.sleep(forTimeInterval: 0.8)
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        XCTAssertNil(findElement(labelContaining: "会话不存在"), "Must never hit 会话不存在 on Home plan send")
        capture("live-04-after-plan-turn")

        // Open PlanSheet via 查看计划 card button if PlanSheet did not auto-open
        if findElement(label: "关闭计划") == nil, let viewPlanBtn = findElement(label: "查看计划") {
            tapSafely(viewPlanBtn)
            Thread.sleep(forTimeInterval: 0.8)
        }
        if findElement(label: "关闭计划") != nil {
            capture("live-05-plan-sheet")
        }

        // If PlanSheet is open, test TOC & collapse into floating capsule ("收起为悬浮条") -> restore from floating pill
        if let tocBtn = findElement(label: "方案目录") {
            tapSafely(tocBtn)
            Thread.sleep(forTimeInterval: 0.5)
            capture("live-06-plan-sheet-toc")
            if let closeToc = findElement(label: "关闭") {
                tapSafely(closeToc)
            } else {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)).tap()
            }
            Thread.sleep(forTimeInterval: 0.4)
        }
        if let collapsePlan = findElement(label: "收起为悬浮条") {
            tapSafely(collapsePlan)
            Thread.sleep(forTimeInterval: 0.5)
            capture("live-07-plan-floating-pill")
            if let reopenPill = findElement(labelContaining: "查看执行方案") {
                tapSafely(reopenPill)
                Thread.sleep(forTimeInterval: 0.5)
                capture("live-07b-plan-reopened")
            }
        }
        if let closePlan = findElement(label: "关闭计划") {
            tapSafely(closePlan)
            Thread.sleep(forTimeInterval: 0.5)
        }

        // 3. Open Right Workspace Drawer: verify 计划 tab is NOT in drawer, then test Sidechat thread
        tapSafely(try waitForElement(label: "工作区", timeout: 10))
        _ = try waitForElement(label: "返回对话", timeout: 10)
        XCTAssertNil(findElement(label: "计划"), "Plan tab must NOT be in RightWorkspaceDrawer")

        // Switch to Sidechat tab and run a real Sidechat question using magpie hy4flash free
        tapSafely(try waitForElement(label: "辅助对话", timeout: 10))
        Thread.sleep(forTimeInterval: 0.8)

        if let sideModel = findFirstElement(labelsContaining: ["模型：", "切换模型", "gemini-", "hy4"]) {
            tapSafely(sideModel)
            let sSearch = try waitForElement(label: "搜索模型", timeout: 12)
            tapAndType(sSearch, text: "magpie hy4")
            Thread.sleep(forTimeInterval: 0.8)
            if let sFree = findFirstElement(labelsContaining: ["free", "hy4flash"]) {
                tapSafely(sFree)
                Thread.sleep(forTimeInterval: 0.6)
            }
            if let doneBtn = findElement(label: "完成") ?? findElement(label: "关闭") {
                tapSafely(doneBtn)
                Thread.sleep(forTimeInterval: 0.5)
            }
        }

        let sideInput = try waitForElement(label: "消息输入框", timeout: 10)
        tapAndType(sideInput, text: "用一句话回答：1+1等于几？不要调用任何工具。")
        tapSafely(try waitForElement(label: "发送", timeout: 8))

        // Wait up to 35s for Sidechat thread to complete and show context usage button + more menu
        _ = try waitForElement(labelContaining: "上下文用量", timeout: 35)
        Thread.sleep(forTimeInterval: 1.2)
        capture("live-09-sidechat-thread")

        // 5. Verify Row 1 top switcher now lists the historical Sidechat thread
        tapSafely(try waitForElement(labelContaining: "切换辅助对话", timeout: 10))
        _ = try waitForElement(label: "关闭切换", timeout: 8)
        capture("live-10-sidechat-switcher-populated")
        if let closeSw = findElement(label: "关闭切换") {
            tapSafely(closeSw)
            Thread.sleep(forTimeInterval: 0.4)
        }

        // 6. Verify Sidechat ContextSheet
        tapSafely(try waitForElement(labelContaining: "上下文用量", timeout: 8))
        Thread.sleep(forTimeInterval: 0.8)
        capture("live-11-sidechat-context-sheet")
        if let closeCtx = findElement(label: "关闭") {
            tapSafely(closeCtx)
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        }
        Thread.sleep(forTimeInterval: 0.6)

        // 7. Verify Sidechat top-right "..." menu -> Rename Sidechat
        tapSafely(try waitForElement(label: "更多操作", timeout: 8))
        let renameAction = try waitForElement(labelContaining: "重命名", timeout: 5)
        capture("live-12-sidechat-more-menu")
        tapSafely(renameAction)
        let nameField = try waitForElement(label: "会话名称", timeout: 8)
        tapAndType(nameField, text: "UI验收")
        capture("live-13-sidechat-rename-modal")
        if let saveBtn = findElement(label: "保存") {
            tapSafely(saveBtn)
            Thread.sleep(forTimeInterval: 1.0)
        }
        capture("live-14-sidechat-renamed")
    }

    // MARK: - Helpers

    private func waitForFirstElement(labelsContaining substrings: [String], timeout: TimeInterval) throws -> XCUIElement {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let match = findFirstElement(labelsContaining: substrings) {
                return match
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        throw NSError(domain: "VecwayUITests", code: 3, userInfo: [
            NSLocalizedDescriptionKey: "Timed out waiting for element matching any of \(substrings)"
        ])
    }

    private func waitForElement(label: String, timeout: TimeInterval) throws -> XCUIElement {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let match = findElement(label: label) {
                return match
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        throw NSError(domain: "VecwayUITests", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Timed out waiting for element with label '\(label)'"
        ])
    }

    private func waitForElement(labelContaining substring: String, timeout: TimeInterval) throws -> XCUIElement {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let match = findElement(labelContaining: substring) {
                return match
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        throw NSError(domain: "VecwayUITests", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "Timed out waiting for element containing '\(substring)'"
        ])
    }

    private func findElement(label: String) -> XCUIElement? {
        let predicate = NSPredicate(format: "label == %@", label)
        return firstVisibleMatch(predicate: predicate)
    }

    private func findElement(labelContaining substring: String) -> XCUIElement? {
        let predicate = NSPredicate(format: "label CONTAINS[c] %@", substring)
        return firstVisibleMatch(predicate: predicate)
    }

    private func findFirstElement(labelsContaining substrings: [String]) -> XCUIElement? {
        for substring in substrings {
            if let match = findElement(labelContaining: substring) {
                return match
            }
        }
        return nil
    }

    private func firstVisibleMatch(predicate: NSPredicate) -> XCUIElement? {
        let candidates = app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
        if let hittable = candidates.first(where: { $0.exists && $0.isHittable }) {
            return hittable
        }
        return candidates.first(where: { $0.exists && !$0.frame.isEmpty })
    }

    private func tapAndType(_ element: XCUIElement, text: String) {
        tapSafely(element)
        Thread.sleep(forTimeInterval: 0.4)
        app.typeText(text)
    }

    private func tapSafely(_ element: XCUIElement) {
        if element.isHittable {
            element.tap()
        } else {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
    }

    private func capture(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
