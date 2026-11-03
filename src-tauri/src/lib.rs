use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

mod capture;

use capture::CaptureState;

/// Health probe for Ollama availability (`#50`).
/// Checks the local daemon (11434) and, when OLLAMA_API_KEY is set in the
/// environment, Ollama Cloud (ollama.com) for GLM-family models.
#[derive(Serialize)]
pub struct OllamaStatus {
    pub local_online: bool,
    pub local_version: Option<String>,
    pub cloud_online: bool,
}

const OLLAMA_LOCAL: &str = "http://127.0.0.1:11434";
const OLLAMA_CLOUD: &str = "https://ollama.com";

#[tauri::command]
async fn ollama_status() -> OllamaStatus {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    // Local daemon.
    let (local_online, local_version) = match client
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
            (true, version)
        }
        Err(_) => (false, None),
    };

    // Ollama Cloud — only when an API key is present in the environment.
    let mut cloud_online = false;
    if let Ok(key) = std::env::var("OLLAMA_API_KEY") {
        if !key.is_empty() {
            if let Ok(resp) = client
                .get(format!("{OLLAMA_CLOUD}/v1/models"))
                .bearer_auth(key)
                .send()
                .await
            {
                cloud_online = resp.status().is_success();
            }
        }
    }

    OllamaStatus {
        local_online,
        local_version,
        cloud_online,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(CaptureState::new()))
        .on_page_load(|_window, payload| {
            println!(
                "[stenollama] page load event: {:?} url={}",
                payload.event(),
                payload.url()
            );
        })
        .setup(|app| {
            if let Some(w) = app.webview_windows().get("main") {
                println!("[stenollama] webview initial url: {:?}", w.url());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ollama_status,
            capture::capture_start,
            capture::capture_stop,
            capture::capture_elapsed
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
