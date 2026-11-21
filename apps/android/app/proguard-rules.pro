# Keep JavascriptInterface bridge methods exposed to WebView
-keepclassmembers class dev.vecway.mobile.web.BridgeInterface {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes *Annotation*

# Keep OkHttp / Okio reflection-safe classes
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
