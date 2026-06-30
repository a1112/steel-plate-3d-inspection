fn main() {
    println!("cargo:rustc-check-cfg=cfg(capture_sdk)");

    #[cfg(windows)]
    {
        use std::{env, fs, path::PathBuf};

        println!("cargo:rerun-if-env-changed=NVT_LVM_SDK_ROOT");

        let sdk_root = env::var_os("NVT_LVM_SDK_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from("C:/Program Files (x86)/Capture 6.7.0.4/LVM_NVT_SDK/LVM_C++_SDK/x64")
            });
        let sdk_lib = sdk_root.join("lib");
        let sdk_dll = sdk_root.join("dll").join("nvt_lvm_sdk.dll");
        let sdk_import_lib = sdk_lib.join("nvt_lvm_sdk.lib");

        println!("cargo:rerun-if-changed={}", sdk_import_lib.display());
        println!("cargo:rerun-if-changed={}", sdk_dll.display());

        if !sdk_import_lib.is_file() {
            println!(
                "cargo:warning=Capture SDK import library not found at {}; building with capture SDK stubs",
                sdk_import_lib.display()
            );
            tauri_build::build();
            return;
        }

        println!("cargo:rustc-link-search=native={}", sdk_lib.display());
        println!("cargo:rustc-link-lib=dylib=nvt_lvm_sdk");
        println!("cargo:rustc-cfg=capture_sdk");

        if sdk_dll.is_file() {
            if let Ok(out_dir) = env::var("OUT_DIR") {
                let out_dir = PathBuf::from(out_dir);
                if let Some(profile_dir) = out_dir.ancestors().nth(3) {
                    let target_dll = profile_dir.join("nvt_lvm_sdk.dll");
                    let _ = fs::copy(&sdk_dll, target_dll);
                }
            }
        }
    }

    tauri_build::build()
}
