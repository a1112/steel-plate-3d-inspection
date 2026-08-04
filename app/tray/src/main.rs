#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod windows_tray {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::process::Command;
    use windows_sys::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteW, Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE,
        NOTIFYICONDATAW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow,
        DispatchMessageW, GetCursorPos, GetMessageW, LoadIconW, MessageBoxW, PostQuitMessage,
        RegisterClassW, SetForegroundWindow, TrackPopupMenu, TranslateMessage, CS_HREDRAW,
        CS_VREDRAW, IDI_APPLICATION, MF_SEPARATOR, MF_STRING, SW_SHOWNORMAL, TPM_BOTTOMALIGN,
        TPM_LEFTALIGN, WM_APP, WM_COMMAND, WM_DESTROY, WM_LBUTTONDBLCLK, WM_RBUTTONUP, WNDCLASSW,
    };

    const TRAY_MESSAGE: u32 = WM_APP + 1;
    const MENU_OPEN: usize = 1001;
    const MENU_STATUS: usize = 1002;
    const MENU_START: usize = 1003;
    const MENU_STOP: usize = 1004;
    const MENU_RESTART: usize = 1005;
    const MENU_AUTOSTART: usize = 1006;
    const MENU_EXIT: usize = 1007;

    static mut TRAY_DATA: Option<NOTIFYICONDATAW> = None;
    static mut TRAY_HWND: HWND = std::ptr::null_mut();

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(once(0)).collect()
    }
    fn exe_dir() -> PathBuf {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("."))
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            TRAY_MESSAGE if lparam as u32 == WM_RBUTTONUP => show_menu(hwnd),
            TRAY_MESSAGE if lparam as u32 == WM_LBUTTONDBLCLK => {
                open_client();
                0
            }
            WM_COMMAND => handle_command(hwnd, (wparam & 0xffff) as usize),
            WM_DESTROY => {
                remove_tray_icon();
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    unsafe fn show_menu(hwnd: HWND) -> LRESULT {
        let menu = CreatePopupMenu();
        if menu == std::ptr::null_mut() {
            return 0;
        }
        let labels = [
            (MENU_OPEN, "打开 Tauri 客户端"),
            (MENU_STATUS, "查看运行状态"),
            (MENU_START, "启动后台服务"),
            (MENU_STOP, "停止后台服务"),
            (MENU_RESTART, "重启后台服务"),
            (MENU_AUTOSTART, "启用登录自启动"),
        ];
        for (id, label) in labels {
            let text = wide(label);
            AppendMenuW(menu, MF_STRING, id, text.as_ptr());
        }
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
        let exit = wide("退出托盘");
        AppendMenuW(menu, MF_STRING, MENU_EXIT, exit.as_ptr());
        let mut point = POINT { x: 0, y: 0 };
        GetCursorPos(&mut point);
        SetForegroundWindow(hwnd);
        TrackPopupMenu(
            menu,
            TPM_LEFTALIGN | TPM_BOTTOMALIGN,
            point.x,
            point.y,
            0,
            hwnd,
            std::ptr::null(),
        );
        DestroyMenu(menu);
        0
    }

    unsafe fn handle_command(hwnd: HWND, command: usize) -> LRESULT {
        match command {
            MENU_OPEN => open_client(),
            MENU_STATUS => show_status(),
            MENU_START => elevated_service_action("start"),
            MENU_STOP => elevated_service_action("stop"),
            MENU_RESTART => elevated_service_action("restart"),
            MENU_AUTOSTART => enable_autostart(),
            MENU_EXIT => {
                DestroyWindow(hwnd);
            }
            _ => {}
        }
        0
    }

    fn open_client() {
        let candidates = [
            exe_dir().join("steel-plate-3d-inspection.exe"),
            exe_dir().join(r"..\client\steel-plate-3d-inspection.exe"),
        ];
        if let Some(path) = candidates.iter().find(|p| p.is_file()) {
            let _ = Command::new(path).spawn();
            return;
        }
        unsafe {
            let text = wide("未找到 Tauri 客户端，请先完成桌面安装。");
            let title = wide("Steel Inspection");
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
        }
    }

    fn show_status() {
        let output = Command::new("sc.exe")
            .args(["query", "SteelInspectionRuntime"])
            .output();
        let text = output
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_else(|| "无法查询 Windows 服务".into());
        unsafe {
            let body = wide(&text);
            let title = wide("Steel Inspection 运行状态");
            MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), 0x40);
        }
    }

    fn elevated_service_action(action: &str) {
        let verb = wide("runas");
        let file = wide("sc.exe");
        let params = wide(&format!("{action} SteelInspectionRuntime"));
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                params.as_ptr(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }

    fn enable_autostart() {
        let tray = std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let _ = Command::new("reg.exe")
            .args([
                "ADD",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "SteelInspectionTray",
                "/t",
                "REG_SZ",
                "/d",
                &tray,
                "/f",
            ])
            .output();
        unsafe {
            let body = wide("已启用当前用户登录自启动");
            let title = wide("Steel Inspection");
            MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), 0x40);
        }
    }

    unsafe fn add_tray_icon(hwnd: HWND) {
        TRAY_HWND = hwnd;
        let mut data: NOTIFYICONDATAW = std::mem::zeroed();
        data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        data.hWnd = hwnd;
        data.uID = 1;
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        data.uCallbackMessage = TRAY_MESSAGE;
        data.hIcon = LoadIconW(std::ptr::null_mut(), IDI_APPLICATION);
        let tip = wide("Steel Inspection 运行托盘");
        for (index, value) in tip.iter().take(data.szTip.len()).enumerate() {
            data.szTip[index] = *value;
        }
        Shell_NotifyIconW(NIM_ADD, &mut data);
        TRAY_DATA = Some(data);
    }
    unsafe fn remove_tray_icon() {
        let data = std::ptr::addr_of_mut!(TRAY_DATA).read();
        if let Some(mut data) = data {
            Shell_NotifyIconW(NIM_DELETE, &mut data);
        }
    }

    pub fn run() {
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let class_name = wide("SteelInspectionTrayWindow");
            let window_class = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(window_proc),
                hInstance: instance as HINSTANCE,
                lpszClassName: class_name.as_ptr(),
                hCursor: std::ptr::null_mut(),
                hIcon: LoadIconW(std::ptr::null_mut(), IDI_APPLICATION),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                cbClsExtra: 0,
                cbWndExtra: 0,
            };
            RegisterClassW(&window_class);
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                class_name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance as HINSTANCE,
                std::ptr::null(),
            );
            if hwnd == std::ptr::null_mut() {
                return;
            }
            add_tray_icon(hwnd);
            let mut message = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            remove_tray_icon();
        }
    }
}

#[cfg(windows)]
fn main() {
    windows_tray::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("steel-inspection-tray is only supported on Windows");
}
