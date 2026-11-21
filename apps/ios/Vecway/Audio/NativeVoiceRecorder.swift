import AVFoundation
import Foundation

enum VoiceRecorderError: Error, LocalizedError {
    case permissionDenied
    case alreadyRecording
    case notRecording
    case recordingFailed(String)
    case emptyAudio
    case audioTooLarge
    case transcriptionFailed(String)

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "未获得麦克风权限，请在系统「设置 → Vecway」中开启麦克风权限"
        case .alreadyRecording:
            return "正在录音中"
        case .notRecording:
            return "当前没有进行中的录音"
        case .recordingFailed(let detail):
            return "录音启动失败：\(detail)"
        case .emptyAudio:
            return "未录到有效语音，请重试"
        case .audioTooLarge:
            return "录音文件超出 25 MB 限制"
        case .transcriptionFailed(let detail):
            return detail.isEmpty ? "语音转文字失败，请检查电脑端语音识别配置" : detail
        }
    }
}

/// Native iOS voice recorder recording AAC (`.m4a`, 16 kHz mono) and uploading raw audio bytes
/// directly to `/api/voice/transcribe` via `EndpointManager` + `PinnedTransport`.
@MainActor
final class NativeVoiceRecorder {
    private static let maxAudioBytes = 25 * 1024 * 1024
    private static let transcribeTimeoutMs = 65_000

    private let endpointManager: EndpointManager
    private var recorder: AVAudioRecorder?
    private var activeFileURL: URL?

    init(endpointManager: EndpointManager) {
        self.endpointManager = endpointManager
    }

    func startRecording() async throws {
        if recorder?.isRecording == true {
            throw VoiceRecorderError.alreadyRecording
        }

        let granted = await requestMicrophonePermission()
        guard granted else {
            throw VoiceRecorderError.permissionDenied
        }

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .measurement,
                options: [.defaultToSpeaker, .allowBluetooth]
            )
            try session.setActive(true)
        } catch {
            throw VoiceRecorderError.recordingFailed(error.localizedDescription)
        }

        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("vecway-voice-\(UUID().uuidString).m4a")

        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]

        do {
            let newRecorder = try AVAudioRecorder(url: tempURL, settings: settings)
            newRecorder.prepareToRecord()
            guard newRecorder.record() else {
                cleanupTempFile(tempURL)
                deactivateSession()
                throw VoiceRecorderError.recordingFailed("无法启动音频采集器")
            }
            self.recorder = newRecorder
            self.activeFileURL = tempURL
        } catch let error as VoiceRecorderError {
            throw error
        } catch {
            cleanupTempFile(tempURL)
            deactivateSession()
            throw VoiceRecorderError.recordingFailed(error.localizedDescription)
        }
    }

    func stopAndTranscribe() async throws -> String {
        guard let activeRecorder = recorder, let fileURL = activeFileURL else {
            throw VoiceRecorderError.notRecording
        }

        activeRecorder.stop()
        self.recorder = nil
        self.activeFileURL = nil
        deactivateSession()

        defer { cleanupTempFile(fileURL) }

        let audioData: Data
        do {
            audioData = try Data(contentsOf: fileURL)
        } catch {
            throw VoiceRecorderError.emptyAudio
        }

        guard !audioData.isEmpty else {
            throw VoiceRecorderError.emptyAudio
        }
        guard audioData.count <= Self.maxAudioBytes else {
            throw VoiceRecorderError.audioTooLarge
        }

        let response = try await endpointManager.performRequest(
            method: "POST",
            path: "/api/voice/transcribe",
            headers: [
                "Content-Type": "audio/mp4",
                "Accept": "application/json",
            ],
            body: audioData,
            timeoutMs: Self.transcribeTimeoutMs
        )

        guard (200...299).contains(response.status) else {
            let msg = PinnedTransport.extractServerErrorMessage(from: response.body)
                ?? "语音转文字失败（HTTP \(response.status)）"
            throw VoiceRecorderError.transcriptionFailed(msg)
        }

        struct TranscribeResponse: Decodable {
            let text: String
        }
        guard let decoded = try? JSONDecoder().decode(TranscribeResponse.self, from: response.body) else {
            throw VoiceRecorderError.transcriptionFailed("无法解析语音识别结果")
        }
        return decoded.text
    }

    func cancelRecording() {
        recorder?.stop()
        recorder = nil
        if let fileURL = activeFileURL {
            cleanupTempFile(fileURL)
            activeFileURL = nil
        }
        deactivateSession()
    }

    private func requestMicrophonePermission() async -> Bool {
        let session = AVAudioSession.sharedInstance()
        switch session.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                session.requestRecordPermission { allowed in
                    continuation.resume(returning: allowed)
                }
            }
        @unknown default:
            return false
        }
    }

    private func cleanupTempFile(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
