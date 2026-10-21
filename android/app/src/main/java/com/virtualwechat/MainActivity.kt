package com.virtualwechat

import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var albumBridge: AlbumBridge
    // 系统分享：页面加载完成前先暂存脚本，onPageFinished 后再投递（仅在主线程读写）
    private var pageReady = false
    private var pendingShareJs: String? = null

    // 相册权限申请结果 -> 通知 Bridge，再由 Bridge 回调网页 JS
    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val granted = result.values.any { it }
        albumBridge.onPermissionResult(granted)
    }

    // 相册缩略图：Bridge 后台线程生成完一张后经此暂存/投递，onPageFinished 后补发
    private val pendingAlbumThumbJs = ArrayDeque<String>()

    fun onAlbumThumbReady(js: String) {
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            if (pageReady) webView.evaluateJavascript(js, null) else pendingAlbumThumbJs.add(js)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        albumBridge = AlbumBridge(this) { granted ->
            // 回到主线程回调网页（JS 接口可能在 Binder 线程触发）
            runOnUiThread {
                webView.evaluateJavascript("window.__onAlbumPermission && window.__onAlbumPermission($granted);", null)
            }
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true                 // localStorage（store.js 持久化）
            allowFileAccess = true                   // 加载导出到缓存的原图 file://
            allowFileAccessFromFileURLs = true
            allowUniversalAccessFromFileURLs = true  // 微信壳私人包，放开本地文件跨域
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            // 【方案 C：真·零点击自动播】B 站外链 iframe 播放器靠 UA 判断渲染桌面版/移动版：
            //   移动版（默认移动 UA）→ 停在封面、必须真人点击 B 站自绘播放按钮才起播；
            //   桌面版 → 尊重 autoplay=1&muted=1，零点击直接播。
            // 这里把整个 UA 换成桌面 Chrome，让 B 站给"桌面版播放器"从而自动播。
            // 全 App 响应式布局基于视口尺寸断点（@media min/max-width），不依赖 UA，
            // 故换桌面 UA 不会把 App 变成桌面版式，移动版式不受影响。
            userAgentString =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                pageReady = true
                pendingShareJs?.let { webView.evaluateJavascript(it, null) }
                pendingShareJs = null
                if (pendingAlbumThumbJs.isNotEmpty()) {
                    val js = pendingAlbumThumbJs.joinToString("\n")
                    pendingAlbumThumbJs.clear()
                    webView.evaluateJavascript(js, null)
                }
            }

            /**
             * 防跳出 B站：移动端 shield 已透传点击，用户能点到 B站 iframe 内的播放按钮起播，
             * 但 iframe 内的其它点击（标题、链接、误触）可能触发导航到 bilibili.com 整站，
             * 那样会直接跳出去、离开 App。这里在 WebView 层拦掉"跳出"，同时【放行】
             * 嵌入的 B 站播放器 iframe（player.bilibili.com/player.html），它才是出画面的载体。
             *
             * 说明：
             *  - 视频 mp4/m3u8 是 iframe 内部子资源，走 shouldInterceptRequest，不经过导航拦截，
             *    故拦导航不影响播放。
             *  - target=_blank 的"点击在B站播放"兜底链接也是 bilibili.com → 一并拦掉，留在 App。
             */
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                // 只处理 http/https 与 file（App 内壳是 file://android_asset/...）
                if (!url.startsWith("http") && !url.startsWith("file")) return false
                // 放行嵌入的 B 站播放器 iframe（出画面必需）
                if (url.startsWith("https://player.bilibili.com/")) return false
                // 跳出到 B站 整站 → 拦掉，留在 App 内（播放器 iframe 自身不受影响）
                if (url.contains("bilibili.com") || url.contains("bilibili.cn")) {
                    android.util.Log.i("VirtualWechat", "block nav to B站: $url")
                    return true
                }
                return false
            }
        }
        // 麦克风：重写 onPermissionRequest，把 WebRTC getUserMedia({audio:true}) 请求的
        // AUDIO 资源【自动放行】，否则 WebChromeClient() 默认实现不授予任何资源，
        // MediaRecorder 永远拿不到音频流（"按住说话"录音无效）。
        //
        // 机制说明：WebView 这一层（onPermissionRequest）只负责"是否允许网页用麦克风"，
        // 实际的系统授权由 Android 在【首次访问设备时】自动弹 RECORD_AUDIO 权限框。
        // 因此这里对 AUDIO 一律 grant —— 系统会接着弹真正的权限框；用户拒绝后
        // 页面侧 getUserMedia 会拿到失败，前端 toast "权限被拒"，并引导去系统设置。
        // 视频资源（摄像头）保守拒绝：本 App 仅用前端 CSS capture input 调系统相机，
        // 不依赖 WebView 的 camera 流，不自动 grant 避免误授权。
        webView.webChromeClient = object : WebChromeClient() {
            @Suppress("OVERRIDE_DEPRECATION")
            override fun onPermissionRequest(request: PermissionRequest) {
                val resources = request.resources
                val hasAudio = resources.any {
                    it.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                }
                if (hasAudio) {
                    // 系统层会在首次访问麦克风时弹权限框，这里只需放行 WebView 层
                    request.grant(resources)
                    android.util.Log.i("VirtualWechat", "onPermissionRequest: AUDIO granted (system will prompt RECORD_AUDIO if not yet)")
                } else {
                    // 非音频资源（摄像头等）→ 保守拒绝
                    @Suppress("DEPRECATION")
                    request.deny()
                }
            }
        }
        webView.addJavascriptInterface(albumBridge, "WXAlbum")
        // 系统状态栏/导航栏颜色随网页内容切换：网页在路由变化时调 WXChrome.setStatusBarColor("#RRGGBB")。
        // 规则（与用户要求一致）：普通白/灰底页 → 浅灰 #EDEDED（与 App 顶条同色）；
        // 视频号（黑底视频）页 → 黑 #000000。
        webView.addJavascriptInterface(object {
            @android.webkit.JavascriptInterface
            fun setStatusBarColor(hex: String) {
                val color = try { android.graphics.Color.parseColor(hex) } catch (e: Exception) { return }
                val light = (android.graphics.Color.red(color) * 0.299f +
                        android.graphics.Color.green(color) * 0.587f +
                        android.graphics.Color.blue(color) * 0.114f) > 150f
                runOnUiThread {
                    window.statusBarColor = color
                    window.navigationBarColor = color
                    // 状态/导航栏前景图标深浅：亮色背景 → 深色图标；暗色背景 → 浅色图标
                    if (android.os.Build.VERSION.SDK_INT >= 30) {
                        // 平台 WindowInsetsController（API 30+）：图标样式走 setSystemBarsAppearance 位掩码。
                        // 注意 setAppearanceLightStatusBars/setAppearanceLightNavigationBars
                        // 是 androidx WindowInsetsControllerCompat 的 API，平台类没有，别混用。
                        val ic = window.insetsController
                        ic?.show(android.view.WindowInsets.Type.statusBars())
                        val mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                                android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                        ic?.setSystemBarsAppearance(if (light) mask else 0, mask)
                    } else {
                        // API 21-29：decorView.systemUiVisibility
                        @Suppress("DEPRECATION")
                        var flags = window.decorView.systemUiVisibility
                        if (light) {
                            flags = flags or android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                            flags = flags or android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                        } else {
                            flags = flags and android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
                            flags = flags and android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
                        }
                        window.decorView.systemUiVisibility = flags
                    }
                }
            }
        }, "WXChrome")

        // 网页工程放在 assets/virtual-wechat/index.html
        // 兜底自检：资源没打进 APK 时，给出可读提示，而不是满屏 net::ERR_FILE_NOT_FOUND
        val entryAsset = "virtual-wechat/index.html"
        val assetOk = try {
            assets.open(entryAsset).use { true }
        } catch (e: Exception) {
            false
        }
        if (assetOk) {
            webView.loadUrl("file:///android_asset/$entryAsset")
        } else {
            android.util.Log.e("VirtualWechat", "MISSING ASSET: $entryAsset — syncAssets 未把网页资源同步进 APK")
            webView.loadDataWithBaseURL(
                null,
                "<h3>资源缺失</h3><p>assets/$entryAsset 未打包进 APK。</p>" +
                    "<p>请在 android 工程执行 Gradle 任务 <code>syncAssets</code>（注意 Build 输出是否有 <code>[syncAssets] 网页源目录</code> 日志），然后 Clean 重新打包。</p>",
                "text/html", "utf-8", null
            )
        }
        if (savedInstanceState == null) handleShareIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShareIntent(intent)
    }

    /** 由 AlbumBridge 在网页线程请求权限时调用，切到主线程启动系统授权弹窗 */
    fun requestAlbumPermission() {
        val perms = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            arrayOf(android.Manifest.permission.READ_MEDIA_IMAGES)
        } else {
            arrayOf(android.Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        // 权限申请入口可能来自 JS 桥（非主线程），launch 必须主线程执行
        runOnUiThread {
            val need = perms.filter {
                ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
            }
            if (need.isEmpty()) {
                albumBridge.onPermissionResult(true)
            } else {
                permissionLauncher.launch(need.toTypedArray())
            }
        }
    }


    /**
     * 处理系统分享（ACTION_SEND / ACTION_SEND_MULTIPLE），转成 JSON 后调用
     * 网页的 window.__VW_deliverShare。图片在后台线程缩放压缩成 data URL。
     */
    @Suppress("DEPRECATION")
    private fun handleShareIntent(intent: Intent?) {
        if (intent == null) return
        val action = intent.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: ""
        val title = intent.getStringExtra(Intent.EXTRA_SUBJECT)
            ?: intent.getStringExtra(Intent.EXTRA_TITLE) ?: ""
        val uris = ArrayList<Uri>()
        try {
            if (action == Intent.ACTION_SEND) {
                val u: Uri? = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU)
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                else intent.getParcelableExtra(Intent.EXTRA_STREAM)
                if (u != null) uris.add(u)
            } else {
                val list: List<Uri>? = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU)
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
                if (list != null) uris.addAll(list)
            }
        } catch (e: Exception) {
            // 读取 extras 失败：忽略图片，仍投递文字
        }
        // 已读取，清除 action，避免重建后重复投递
        intent.action = null

        Thread {
            val images = JSONArray()
            var total = 0
            for (uri in uris.take(SHARE_MAX_IMAGES)) {
                val dataUrl = (try { uriToDataUrl(uri) } catch (e: Throwable) { null }) ?: continue
                if (total + dataUrl.length > SHARE_MAX_TOTAL_CHARS) break
                total += dataUrl.length
                images.put(dataUrl)
            }
            val json = JSONObject().apply {
                put("type", if (images.length() > 0) "image" else "text")
                put("text", text)
                put("title", title)
                put("url", Regex("https?://\\S+").find(text)?.value ?: "")
                put("images", images)
            }
            val js = "window.__VW_deliverShare && window.__VW_deliverShare($json);"
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (pageReady) webView.evaluateJavascript(js, null) else pendingShareJs = js
            }
        }.start()
    }

    /** content:// 图片 -> 最长边 1280、JPEG 75 的 data URL；两步解码避免 OOM，流均已关闭 */
    private fun uriToDataUrl(uri: Uri): String? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= SHARE_MAX_EDGE) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val bmp = contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
        var out = bmp
        val longest = maxOf(bmp.width, bmp.height)
        if (longest > SHARE_MAX_EDGE) {
            val r = SHARE_MAX_EDGE.toFloat() / longest
            out = Bitmap.createScaledBitmap(bmp, maxOf(1, (bmp.width * r).toInt()), maxOf(1, (bmp.height * r).toInt()), true)
            if (out !== bmp) bmp.recycle()
        }
        val bos = ByteArrayOutputStream()
        out.compress(Bitmap.CompressFormat.JPEG, 75, bos)
        out.recycle()
        return "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
    }

    companion object {
        private const val SHARE_MAX_IMAGES = 9
        private const val SHARE_MAX_EDGE = 1280
        private const val SHARE_MAX_TOTAL_CHARS = 8_000_000 // base64 约 6MB 原始字节
    }
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
