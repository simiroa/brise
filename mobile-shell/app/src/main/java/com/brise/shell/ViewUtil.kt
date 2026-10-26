package com.brise.shell

import android.content.Context
import android.util.TypedValue
import android.view.View

// 네이티브 화면([SetupView]·[ErrorOverlay])이 같이 쓰는 작은 헬퍼.

/** dp → px. */
internal fun View.dp(v: Int): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

/** 현재 테마의 창 배경색 — 네이티브 화면이 뒤의 WebView 를 가리는 데 쓴다. */
internal fun Context.themeBackground(): Int =
    TypedValue().also { theme.resolveAttribute(android.R.attr.colorBackground, it, true) }.data
