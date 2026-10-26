plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.brise.shell"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.brise.shell"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.2-s1"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // OnBackPressedCallback + registerForActivityResult (ComponentActivity)
    implementation("androidx.activity:activity-ktx:1.9.3")
    // WebViewCompat.addWebMessageListener (origin 허용목록 브리지)
    implementation("androidx.webkit:webkit:1.12.1")
    // QR 스캔 (Google Play 서비스 제공 UI — 카메라 권한 불필요)
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
