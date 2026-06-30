fn main() {
    #[cfg(windows)]
    {
        use std::{env, fs, path::PathBuf};

        let sdk_root = PathBuf::from("C:/Program Files (x86)/Capture 6.7.0.4/LVM_NVT_SDK/LVM_C++_SDK/x64");
        let sdk_lib = sdk_root.join("lib");
        let sdk_dll = sdk_root.join("dll").join("nvt_lvm_sdk.dll");

        println!("cargo:rustc-link-search=native={}", sdk_lib.display());
        println!("cargo:rustc-link-lib=dylib=nvt_lvm_sdk");
        println!("cargo:rerun-if-changed={}", sdk_dll.display());

        if let Ok(out_dir) = env::var("OUT_DIR") {
            let out_dir = PathBuf::from(out_dir);
            if let Some(profile_dir) = out_dir.ancestors().nth(3) {
                let target_dll = profile_dir.join("nvt_lvm_sdk.dll");
                let _ = fs::copy(&sdk_dll, target_dll);
            }
        }
    }

    tauri_build::build()
}
