import Foundation
import XCTest
#if canImport(VecwayCore)
@testable import VecwayCore
#elseif canImport(Vecway)
@testable import Vecway
#endif

final class SSELineParserTests: XCTestCase {
    func testBasicCustomEventAndDefaultMessageType() {
        var parser = SSELineParser()
        let events = parser.append(
            "data: default payload\n\n"
            + "event: rpc\n"
            + "data: {\"type\":\"delta\",\"text\":\"hi\"}\n\n"
        )
        XCTAssertEqual(events, [
            SSEEvent(type: "message", data: "default payload"),
            SSEEvent(type: "rpc", data: #"{"type":"delta","text":"hi"}"#),
        ])
    }

    func testMultiLineDataJoiningAndSingleLeadingSpaceStripping() {
        var parser = SSELineParser()
        let events = parser.append("event: session\ndata: line 1\ndata:  indented line 2\ndata:line 3\n\n")
        XCTAssertEqual(events, [
            SSEEvent(type: "session", data: "line 1\n indented line 2\nline 3"),
        ])
    }

    func testCommentsIgnoredAndDoNotEmitEvents() {
        var parser = SSELineParser()
        let events = parser.append(": keep-alive\n\n: another comment\nevent: hello\n: mid comment\ndata: ok\n\n")
        XCTAssertEqual(events, [
            SSEEvent(type: "hello", data: "ok"),
        ])
    }

    func testCRLFAndSplitCRAndLFChunks() {
        var parser = SSELineParser()
        var collected: [SSEEvent] = []
        collected += parser.append("event: touch\r")
        collected += parser.append("\ndata: first\r")
        collected += parser.append("\n\r")
        collected += parser.append("\ndata: second\r\r")

        XCTAssertEqual(collected, [
            SSEEvent(type: "touch", data: "first"),
            SSEEvent(type: "message", data: "second"),
        ])
    }

    func testByteByByteChunkSplittingPreservesMultibyteUTF8() {
        var parser = SSELineParser()
        let raw = Data("event: rpc\ndata: 你好世界🚀 Vecway 加密流\n\n".utf8)
        var collected: [SSEEvent] = []

        for idx in raw.indices {
            let singleByte = Data([raw[idx]])
            collected += parser.append(singleByte)
        }

        XCTAssertEqual(collected, [
            SSEEvent(type: "rpc", data: "你好世界🚀 Vecway 加密流"),
        ])
    }

    func testLeadingUTF8BOMStripped() {
        var parser = SSELineParser()
        var chunk = Data([0xEF, 0xBB, 0xBF])
        chunk.append(Data("event: hello\ndata: ready\n\n".utf8))

        let events = parser.append(chunk)
        XCTAssertEqual(events, [
            SSEEvent(type: "hello", data: "ready"),
        ])
    }
}
