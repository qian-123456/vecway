import SwiftUI
import UIKit

/// High-visibility security hard-blocking screen shown whenever leaf certificate DER SHA-256
/// differs from the locally pinned fingerprint.
///
/// SECURITY REDLINE: Deliberately provides ONLY "重新扫码配对" and "解除配对" —
/// ZERO "ignore / continue anyway" option and NO silent fallback.
struct PinMismatchView: View {
    let mismatch: NativePinMismatch
    let onRescan: () -> Void
    let onUnpair: () -> Void

    @State private var showFullFingerprints = false

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground)
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.shield.fill")
                            .font(.system(size: 56))
                            .foregroundColor(.red)

                        Text("安全阻断：证书指纹不匹配")
                            .font(.title2.weight(.bold))
                            .multilineTextAlignment(.center)

                        Text("\(mismatch.channel.displayName) · \(mismatch.host)")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 5)
                            .background(Color.red.opacity(0.12), in: Capsule())
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 12)

                    Text("已立即中止加密连接并关闭全部实时通道。系统不会自动降级到其它通道，也不允许跳过校验继续连接。")
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                    VStack(spacing: 12) {
                        fingerprintCard(
                            title: "已信任指纹（本机锁定）",
                            abbreviated: CertificateFingerprint.abbreviated(mismatch.expectedSha256),
                            accent: .green
                        )
                        fingerprintCard(
                            title: "当前服务端指纹（不匹配）",
                            abbreviated: CertificateFingerprint.abbreviated(mismatch.actualSha256),
                            accent: .red
                        )
                    }

                    DisclosureGroup(isExpanded: $showFullFingerprints) {
                        VStack(alignment: .leading, spacing: 12) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("已信任完整 SHA-256")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Text(mismatch.expectedSha256)
                                    .font(.system(.caption2, design: .monospaced))
                                    .textSelection(.enabled)
                            }
                            VStack(alignment: .leading, spacing: 4) {
                                Text("当前服务端完整 SHA-256")
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(.red)
                                Text(mismatch.actualSha256)
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundColor(.red)
                                    .textSelection(.enabled)
                            }
                        }
                        .padding(.top, 8)
                    } label: {
                        Text("查看完整 256 位 SHA-256 指纹")
                            .font(.subheadline.weight(.medium))
                    }
                    .padding(14)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                    VStack(alignment: .leading, spacing: 8) {
                        Text("可能原因")
                            .font(.subheadline.weight(.semibold))
                        bulletRow("电脑端被重装或清空了证书目录（mobile-tls）")
                        bulletRow("电脑端更改了 DDNS 域名导致证书重新签发")
                        bulletRow("当前网络存在中间人劫持（MITM）攻击风险")
                        Text("请先在电脑端「设置 → 手机访问」核对当前证书指纹，确认安全后再重新扫码配对。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.top, 4)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                    VStack(spacing: 12) {
                        Button(action: onRescan) {
                            Label("重新扫码配对", systemImage: "qrcode.viewfinder")
                                .font(.headline)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 6)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.red)

                        Button(role: .destructive, action: onUnpair) {
                            Text("解除配对")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 6)
                        }
                        .buttonStyle(.bordered)
                    }
                    .padding(.top, 4)
                }
                .padding(20)
            }
        }
    }

    private func fingerprintCard(title: String, abbreviated: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundColor(accent)
            Text(abbreviated)
                .font(.system(.body, design: .monospaced).weight(.semibold))
                .textSelection(.enabled)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(accent.opacity(0.35), lineWidth: 1)
        )
    }

    private func bulletRow(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
                .font(.footnote.weight(.bold))
                .foregroundStyle(.secondary)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}
