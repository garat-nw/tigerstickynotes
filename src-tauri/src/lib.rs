// All Proton traffic goes through tauri-plugin-http (native HTTP, no browser CORS rules),
// restricted by the allow-list in capabilities/default.json.
// The Proton session is kept in the OS keychain through the three secret_* commands below.

#[cfg(any(windows, target_os = "macos", target_os = "ios"))]
mod secrets {
    use keyring::{Entry, Error};
    const SERVICE: &str = "me.tigerstickynotes.app";
    const ACCOUNT: &str = "proton-session";
    fn entry() -> Result<Entry, String> { Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string()) }

    #[tauri::command]
    pub fn secret_get() -> Result<Option<String>, String> {
        match entry()?.get_password() { Ok(s) => Ok(Some(s)), Err(Error::NoEntry) => Ok(None), Err(e) => Err(e.to_string()) }
    }
    #[tauri::command]
    pub fn secret_set(value: String) -> Result<(), String> { entry()?.set_password(&value).map_err(|e| e.to_string()) }
    #[tauri::command]
    pub fn secret_delete() -> Result<(), String> {
        match entry()?.delete_credential() { Ok(()) | Err(Error::NoEntry) => Ok(()), Err(e) => Err(e.to_string()) }
    }
}

// Platforms without a keychain backend yet (Android / Linux): sessions simply are not remembered.
#[cfg(not(any(windows, target_os = "macos", target_os = "ios")))]
mod secrets {
    #[tauri::command]
    pub fn secret_get() -> Result<Option<String>, String> { Ok(None) }
    #[tauri::command]
    pub fn secret_set(_value: String) -> Result<(), String> { Ok(()) }
    #[tauri::command]
    pub fn secret_delete() -> Result<(), String> { Ok(()) }
}

// Board mirror files: only tiger-*.md inside an existing folder; written atomically (temp file + rename).
mod mirror {
    use std::{fs, path::PathBuf};
    fn target(dir: &str, name: &str) -> Result<PathBuf, String> {
        let ok = name.starts_with("tiger-") && name.ends_with(".md") && name.len() < 120
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
        if !ok { return Err("invalid board file name".into()); }
        let d = PathBuf::from(dir);
        if !d.is_dir() { return Err(format!("folder not found: {}", dir)); }
        Ok(d.join(name))
    }
    #[tauri::command]
    pub fn mirror_read(dir: String, name: String) -> Result<Option<String>, String> {
        let p = target(&dir, &name)?;
        match fs::read_to_string(&p) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    #[tauri::command]
    pub fn mirror_write(dir: String, name: String, content: String) -> Result<(), String> {
        let p = target(&dir, &name)?;
        let tmp = p.with_extension("md.tmp");
        fs::write(&tmp, content).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &p).map_err(|e| e.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            secrets::secret_get, secrets::secret_set, secrets::secret_delete,
            mirror::mirror_read, mirror::mirror_write
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tiger Sticky Notes");
}
