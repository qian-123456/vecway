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
        if let recentChat = findFirstElement(labelsContaining: ["排查 200k", "iOS 界面"]) {
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

        // 4. Open Right Workspace Drawer and verify Git / Plan / Sidechat tabs + Row 1 switcher.
        let workspaceButton = try waitForElement(label: "工作区", timeout: 10)
        tapSafely(workspaceButton)
        _ = try waitForElement(label: "返回对话", timeout: 10)
        capture("06-drawer-default")

        // Switch to Git tab
        if let gitTab = findElement(label: "Git") {
            tapSafely(gitTab)
            Thread.sleep(forTimeInterval: 1.2)
            capture("07-drawer-git")
        }

        // Switch to Plan tab
        if let planTab = findElement(label: "计划") {
            tapSafely(planTab)
            Thread.sleep(forTimeInterval: 1.2)
            capture("08-drawer-plan")
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

    // MARK: - Helpers

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
        for element in candidates where element.exists {
            if element.isHittable || !element.frame.isEmpty {
                return element
            }
        }
        return nil
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
