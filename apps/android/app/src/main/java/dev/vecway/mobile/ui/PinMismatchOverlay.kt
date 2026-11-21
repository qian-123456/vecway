package dev.vecway.mobile.ui

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import dev.vecway.mobile.network.NativePinMismatch
import dev.vecway.mobile.security.CertificateFingerprint

/**
 * High-visibility native security hard-blocking overlay shown whenever the peer leaf certificate
 * DER SHA-256 differs from the locally pinned fingerprint.
 *
 * SECURITY REDLINE: Deliberately provides ONLY "重新扫码配对" and "解除配对" —
 * ZERO "ignore / continue anyway" option and NO silent fallback.
 */
class PinMismatchOverlay(
    context: Context,
    private val onRescan: () -> Unit,
    private val onUnpair: () -> Unit,
) : FrameLayout(context) {

    private val channelBadge: TextView
    private val expectedShortView: TextView
    private val actualShortView: TextView
    private val expectedFullView: TextView
    private val actualFullView: TextView
    private val fullContainer: LinearLayout
    private val toggleFullButton: TextView

    private var expanded = false

    init {
        visibility = View.GONE
        isClickable = true
        isFocusable = true
        setBackgroundColor(Color.parseColor("#0C0D10"))

        val scroll = ScrollView(context).apply {
            isFillViewport = true
        }
        val content = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            val pad = dp(20)
            setPadding(pad, dp(48), pad, dp(32))
        }

        val header = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }

        val iconView = TextView(context).apply {
            text = "!"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#DC2626"))
            }
            layoutParams = LinearLayout.LayoutParams(dp(56), dp(56)).apply {
                bottomMargin = dp(12)
            }
        }
        header.addView(iconView)

        val titleView = TextView(context).apply {
            text = "安全阻断：证书指纹不匹配"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 21f)
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#F5F5F7"))
            gravity = Gravity.CENTER
        }
        header.addView(titleView)

        channelBadge = TextView(context).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(Color.parseColor("#FCA5A5"))
            setPadding(dp(12), dp(5), dp(12), dp(5))
            background = roundedBg(Color.parseColor("#2A1215"), 999)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(10)
            }
        }
        header.addView(channelBadge)
        content.addView(header)

        val alertBox = TextView(context).apply {
            text = "已立即中止加密连接并关闭全部实时通道。系统不会自动降级到其它通道，也不允许跳过校验继续连接。"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(Color.parseColor("#FEE2E2"))
            setLineSpacing(dp(2).toFloat(), 1f)
            setPadding(dp(14), dp(14), dp(14), dp(14))
            background = roundedBg(Color.parseColor("#2A1215"), 14, Color.parseColor("#7F1D1D"))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(18)
            }
        }
        content.addView(alertBox)

        val expectedCard = buildFingerprintCard(
            title = "已信任指纹（本机锁定）",
            accentColor = Color.parseColor("#4ADE80"),
            borderColor = Color.parseColor("#166534"),
        )
        expectedShortView = expectedCard.second
        content.addView(expectedCard.first)

        val actualCard = buildFingerprintCard(
            title = "当前服务端指纹（不匹配）",
            accentColor = Color.parseColor("#F87171"),
            borderColor = Color.parseColor("#991B1B"),
        )
        actualShortView = actualCard.second
        content.addView(actualCard.first)

        val disclosureCard = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            background = roundedBg(Color.parseColor("#16181D"), 14, Color.parseColor("#262932"))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(12)
            }
        }

        toggleFullButton = TextView(context).apply {
            text = "查看完整 256 位 SHA-256 指纹 ▾"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#E5E7EB"))
        }
        disclosureCard.addView(toggleFullButton)

        fullContainer = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(0, dp(10), 0, 0)
        }
        fullContainer.addView(makeLabel("已信任完整 SHA-256", Color.parseColor("#9CA3AF")))
        expectedFullView = makeMonoText(Color.parseColor("#E5E7EB"))
        fullContainer.addView(expectedFullView)

        fullContainer.addView(
            makeLabel("当前服务端完整 SHA-256", Color.parseColor("#F87171")).apply {
                setPadding(0, dp(10), 0, 0)
            },
        )
        actualFullView = makeMonoText(Color.parseColor("#FCA5A5"))
        fullContainer.addView(actualFullView)
        disclosureCard.addView(fullContainer)

        disclosureCard.setOnClickListener {
            expanded = !expanded
            fullContainer.visibility = if (expanded) View.VISIBLE else View.GONE
            toggleFullButton.text = if (expanded) {
                "收起完整 256 位 SHA-256 指纹 ▴"
            } else {
                "查看完整 256 位 SHA-256 指纹 ▾"
            }
        }
        content.addView(disclosureCard)

        val reasonsCard = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            background = roundedBg(Color.parseColor("#16181D"), 14, Color.parseColor("#262932"))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(12)
            }
        }
        reasonsCard.addView(
            TextView(context).apply {
                text = "可能原因"
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.parseColor("#F3F4F6"))
                setPadding(0, 0, 0, dp(6))
            },
        )
        listOf(
            "• 电脑端被重装或清空了证书目录（mobile-tls）",
            "• 电脑端更改了 DDNS 域名导致证书重新签发",
            "• 当前网络存在中间人劫持（MITM）攻击风险",
        ).forEach { line ->
            reasonsCard.addView(
                TextView(context).apply {
                    text = line
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                    setTextColor(Color.parseColor("#9CA3AF"))
                    setPadding(0, dp(2), 0, dp(2))
                },
            )
        }
        reasonsCard.addView(
            TextView(context).apply {
                text = "请先在电脑端「设置 → 手机访问」核对当前证书指纹，确认安全后再重新扫码配对。"
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                setTextColor(Color.parseColor("#D1D5DB"))
                setPadding(0, dp(8), 0, 0)
            },
        )
        content.addView(reasonsCard)

        val rescanButton = Button(context).apply {
            text = "重新扫码配对"
            isAllCaps = false
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            background = roundedBg(Color.parseColor("#DC2626"), 12)
            setPadding(dp(16), dp(13), dp(16), dp(13))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(20)
            }
            setOnClickListener { onRescan() }
        }
        content.addView(rescanButton)

        val unpairButton = Button(context).apply {
            text = "解除配对"
            isAllCaps = false
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#FCA5A5"))
            background = roundedBg(Color.parseColor("#181A20"), 12, Color.parseColor("#7F1D1D"))
            setPadding(dp(16), dp(12), dp(16), dp(12))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(10)
            }
            setOnClickListener { onUnpair() }
        }
        content.addView(unpairButton)

        scroll.addView(content)
        addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    fun render(mismatch: NativePinMismatch?) {
        if (mismatch == null) {
            visibility = View.GONE
            return
        }
        channelBadge.text = "${mismatch.channel.displayName} · ${mismatch.host}"
        expectedShortView.text = CertificateFingerprint.shortSummary(mismatch.expectedSha256)
        actualShortView.text = CertificateFingerprint.shortSummary(mismatch.actualSha256)
        expectedFullView.text = mismatch.expectedSha256
        actualFullView.text = mismatch.actualSha256
        visibility = View.VISIBLE
        bringToFront()
    }

    private fun buildFingerprintCard(
        title: String,
        accentColor: Int,
        borderColor: Int,
    ): Pair<LinearLayout, TextView> {
        val card = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = roundedBg(Color.parseColor("#16181D"), 14, borderColor)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(12)
            }
        }
        card.addView(makeLabel(title, accentColor))
        val valueView = TextView(context).apply {
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setTextColor(Color.parseColor("#F5F5F7"))
            setTextIsSelectable(true)
            setPadding(0, dp(4), 0, 0)
        }
        card.addView(valueView)
        return Pair(card, valueView)
    }

    private fun makeLabel(text: String, color: Int): TextView = TextView(context).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(color)
    }

    private fun makeMonoText(color: Int): TextView = TextView(context).apply {
        typeface = Typeface.MONOSPACE
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTextColor(color)
        setTextIsSelectable(true)
        setPadding(0, dp(3), 0, 0)
    }

    private fun roundedBg(fillColor: Int, radiusDp: Int, strokeColor: Int? = null): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(radiusDp).toFloat()
            setColor(fillColor)
            if (strokeColor != null) {
                setStroke(dp(1), strokeColor)
            }
        }
    }

    private fun dp(value: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP,
        value.toFloat(),
        resources.displayMetrics,
    ).toInt()
}
