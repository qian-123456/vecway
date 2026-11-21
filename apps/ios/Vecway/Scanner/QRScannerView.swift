import AVFoundation
import SwiftUI
import UIKit

/// Native QR scanner & pairing confirmation sheet supporting both dual-use `#app=` QR codes
/// and `vecway://pair?...` deep links, plus manual link paste fallback for Simulator / denied camera.
struct QRScannerView: View {
    @ObservedObject var controller: AppController
    @Environment(\.dismiss) private var dismiss

    @State private var cameraPermission: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var hasCameraHardware: Bool = AVCaptureDevice.default(for: .video) != nil
    @State private var showManualInput: Bool = false
    @State private var manualLink: String = ""
    @State private var parsedPayload: PairingPayload?
    @State private var parseError: String?
    @State private var pairingError: String?
    @State private var isPairing: Bool = false
    @State private var showFullFingerprint: Bool = false

    init(controller: AppController, initialPayload: PairingPayload? = nil) {
        self.controller = controller
        _parsedPayload = State(initialValue: initialPayload)
    }

    var body: some View {
        NavigationStack {
            Group {
                if let payload = parsedPayload {
                    confirmationView(payload: payload)
                } else if showManualInput || !hasCameraHardware || cameraPermission == .denied || cameraPermission == .restricted {
                    manualInputView
                } else {
                    cameraScannerView
                }
            }
            .navigationTitle(parsedPayload == nil ? "扫码配对电脑" : "确认安全配对")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        dismiss()
                    }
                    .disabled(isPairing)
                }
            }
            .task {
                if hasCameraHardware && cameraPermission == .notDetermined {
                    let granted = await AVCaptureDevice.requestAccess(for: .video)
                    cameraPermission = granted ? .authorized : .denied
                }
            }
        }
    }

    // MARK: - Live Camera Viewfinder

    private var cameraScannerView: some View {
        ZStack {
            QRCameraPreviewView(
                isScanning: parsedPayload == nil && !showManualInput,
                onCodeDetected: handleScannedString
            )
            .ignoresSafeArea(edges: .bottom)

            VStack(spacing: 20) {
                Spacer()

                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.92), lineWidth: 2.5)
                    .frame(width: 248, height: 248)
                    .background(Color.black.opacity(0.08).clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous)))
                    .shadow(color: .black.opacity(0.35), radius: 12)

                Text("请对准电脑端「设置 → 手机访问」中的配对二维码")
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(.white)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: Capsule())

                if let parseError {
                    Text(parseError)
                        .font(.footnote.weight(.medium))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Color.red.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .padding(.horizontal, 24)
                }

                Spacer()

                Button {
                    parseError = nil
                    showManualInput = true
                } label: {
                    Label("手动粘贴配对链接", systemImage: "doc.on.clipboard")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 18)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
                .tint(.black.opacity(0.72))
                .padding(.bottom, 28)
            }
        }
    }

    // MARK: - Manual Paste / Permission Denied Fallback

    private var manualInputView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if hasCameraHardware && (cameraPermission == .denied || cameraPermission == .restricted) {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("相机权限未开启", systemImage: "camera.fill")
                            .font(.headline)
                        Text("如需直接扫码，请在系统设置中允许 Vecway 访问相机；也可以在下方手动粘贴电脑端配对链接。")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Button("前往系统设置") {
                            if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(settingsURL)
                            }
                        }
                        .buttonStyle(.bordered)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                } else if !hasCameraHardware {
                    Label("当前设备无可用相机，请粘贴配对链接完成配对", systemImage: "qrcode")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("配对链接")
                        .font(.subheadline.weight(.semibold))
                    TextField("粘贴 vecway://pair?... 或含 #app= 的配对链接", text: $manualLink, axis: .vertical)
                        .lineLimit(3...6)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.footnote, design: .monospaced))
                        .padding(12)
                        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                if let parseError {
                    Label(parseError, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundColor(.red)
                }

                HStack(spacing: 12) {
                    Button {
                        if let pasted = UIPasteboard.general.string {
                            manualLink = pasted
                            parseError = nil
                        }
                    } label: {
                        Label("从剪贴板粘贴", systemImage: "doc.on.clipboard")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)

                    Button {
                        handleScannedString(manualLink)
                    } label: {
                        Text("解析链接")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(manualLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if hasCameraHardware && cameraPermission == .authorized {
                    Button {
                        parseError = nil
                        showManualInput = false
                    } label: {
                        Label("返回相机扫码", systemImage: "camera")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderless)
                    .padding(.top, 8)
                }
            }
            .padding(20)
        }
    }

    // MARK: - Fingerprint & Endpoint Confirmation Card

    private func confirmationView(payload: PairingPayload) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 12) {
                    Image(systemName: "lock.shield.fill")
                        .font(.system(size: 30))
                        .foregroundColor(.accentColor)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("核对加密连接与证书指纹")
                            .font(.headline)
                        Text("所有通信均强制使用 HTTPS/TLS，设备令牌仅存于本机钥匙串")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("加密通道候选地址")
                        .font(.subheadline.weight(.semibold))

                    if let lan = payload.endpoints.lanTls {
                        endpointRow(label: "局域网 TLS", url: lan, badge: "优先")
                    }
                    if let v6 = payload.endpoints.ipv6 {
                        endpointRow(label: "IPv6 TLS", url: v6, badge: nil)
                    }
                    if let tunnel = payload.endpoints.tunnel {
                        endpointRow(label: "Cloudflare Tunnel", url: tunnel, badge: "系统 CA")
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                VStack(alignment: .leading, spacing: 8) {
                    Text("证书 SHA-256 指纹")
                        .font(.subheadline.weight(.semibold))

                    if let fp = payload.certSha256 {
                        Text(CertificateFingerprint.abbreviated(fp))
                            .font(.system(.body, design: .monospaced).weight(.semibold))
                            .textSelection(.enabled)

                        Text("请与电脑端「设置 → 手机访问」中展示的证书指纹核对一致。")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        DisclosureGroup(isExpanded: $showFullFingerprint) {
                            Text(fp)
                                .font(.system(.caption2, design: .monospaced))
                                .textSelection(.enabled)
                                .padding(.top, 6)
                        } label: {
                            Text("查看完整 256 位指纹")
                                .font(.caption.weight(.medium))
                        }
                    } else {
                        Text("仅使用 Cloudflare Tunnel（由系统根证书校验）")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                if let pairingError {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.octagon.fill")
                            .foregroundColor(.red)
                        Text(pairingError)
                            .font(.footnote)
                            .foregroundColor(.red)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                VStack(spacing: 10) {
                    Button {
                        performPairing(payload)
                    } label: {
                        HStack {
                            if isPairing {
                                ProgressView()
                                    .tint(.white)
                                    .padding(.trailing, 4)
                            }
                            Text(isPairing ? "正在建立加密配对…" : "确认安全配对")
                                .font(.headline)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isPairing)

                    Button("重新扫描或输入链接") {
                        parsedPayload = nil
                        pairingError = nil
                        parseError = nil
                        showFullFingerprint = false
                    }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
                    .disabled(isPairing)
                }
            }
            .padding(20)
        }
    }

    private func endpointRow(label: String, url: String, badge: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if let badge {
                    Text(badge)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Color.accentColor.opacity(0.15), in: Capsule())
                        .foregroundColor(.accentColor)
                }
            }
            Text(url)
                .font(.system(.footnote, design: .monospaced))
                .lineLimit(2)
                .textSelection(.enabled)
        }
    }

    // MARK: - Actions

    private func handleScannedString(_ raw: String) {
        guard parsedPayload == nil else { return }
        do {
            let payload = try PairingPayload.parse(raw)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            parseError = nil
            pairingError = nil
            parsedPayload = payload
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            parseError = error.localizedDescription
        }
    }

    private func performPairing(_ payload: PairingPayload) {
        isPairing = true
        pairingError = nil
        Task {
            do {
                try await controller.confirmPairing(payload: payload)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                isPairing = false
                dismiss()
            } catch {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                pairingError = error.localizedDescription
                isPairing = false
            }
        }
    }
}

// MARK: - AVFoundation Camera Controller

private struct QRCameraPreviewView: UIViewControllerRepresentable {
    let isScanning: Bool
    let onCodeDetected: (String) -> Void

    func makeUIViewController(context: Context) -> QRCameraViewController {
        let vc = QRCameraViewController()
        vc.onCodeDetected = onCodeDetected
        return vc
    }

    func updateUIViewController(_ uiViewController: QRCameraViewController, context: Context) {
        uiViewController.onCodeDetected = onCodeDetected
        uiViewController.setScanningActive(isScanning)
    }
}

private final class QRCameraViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCodeDetected: ((String) -> Void)?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "dev.vecway.mobile.qr-camera")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var isConfigured = false
    private var scanningActive = true
    private var lastDetectedValue: String?
    private var lastDetectedAt: Date = .distantPast

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview

        configureAndStart()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [weak self] in
            if self?.session.isRunning == true {
                self?.session.stopRunning()
            }
        }
    }

    func setScanningActive(_ active: Bool) {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.scanningActive = active
            guard self.isConfigured else { return }
            if active && !self.session.isRunning {
                self.session.startRunning()
            } else if !active && self.session.isRunning {
                self.session.stopRunning()
            }
        }
    }

    private func configureAndStart() {
        sessionQueue.async { [weak self] in
            guard let self, !self.isConfigured else { return }
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  self.session.canAddInput(input) else {
                return
            }

            self.session.beginConfiguration()
            self.session.addInput(input)

            let output = AVCaptureMetadataOutput()
            if self.session.canAddOutput(output) {
                self.session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                if output.availableMetadataObjectTypes.contains(.qr) {
                    output.metadataObjectTypes = [.qr]
                }
            }
            self.session.commitConfiguration()
            self.isConfigured = true

            if self.scanningActive {
                self.session.startRunning()
            }
        }
    }

    nonisolated func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let readable = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              readable.type == .qr,
              let value = readable.stringValue,
              !value.isEmpty else {
            return
        }

        MainActor.assumeIsolated {
            let now = Date()
            if value == self.lastDetectedValue && now.timeIntervalSince(self.lastDetectedAt) < 1.5 {
                return
            }
            self.lastDetectedValue = value
            self.lastDetectedAt = now
            self.onCodeDetected?(value)
        }
    }
}
