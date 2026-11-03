use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;

mod capture;

use capture::CaptureState;

/// Health probe for the local Ollama daemon (`#50`, first slice).
#[derive(Serialize)]
pub struct OllamaStatus {
    pub online: bool,
    pub version: Option<String>,
}

const OLLAMA_LOCAL: &str = "http://127.0.0.1:11434";

#[tauri::command]
async fn ollama_status() -> OllamaStatus {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    match client
        .get(format!("{OLLAMA_LOCAL}/api/version"))
        .send()
        .await
    {
        Ok(resp) => {
            let version = resp
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("version").and_then(|s| s.as_str()).map(str::to_owned));
            OllamaStatus {
                online: true,
                version,
            }
        }
        Err(_) => OllamaStatus {
            online: false,
            version: None,
        },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(CaptureState::new()))
        .invoke_handler(tauri::generate_handler![
            ollama_status,
            capture::capture_start,
            capture::capture_stop,
            capture::capture_elapsed
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
