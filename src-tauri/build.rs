fn main() {
    // tray-icon(muda)이 comctl32 v6 전용 TaskDialogIndirect를 load-time import 한다.
    // 앱 bin은 tauri-build가 심는 common-controls v6 매니페스트로 살지만, 매니페스트 없는
    // lib 테스트 하니스는 구버전 comctl32에 바인딩돼 STATUS_ENTRYPOINT_NOT_FOUND로 즉사한다
    // (2026-07-29 진단). rustc-link-arg-tests는 lib 단위테스트에 적용되지 않으므로(cargo 한계),
    // comctl32를 delay-load로 돌린다: 앱은 첫 호출 시점(v6 활성화 후) 해석, 테스트는 호출이
    // 없어 로딩 자체가 없다. delayimp.lib는 /DELAYLOAD 헬퍼 런타임.
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-arg=delayimp.lib");
        println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
    }
    tauri_build::build()
}
