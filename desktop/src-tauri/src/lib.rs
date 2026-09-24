use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, Url};

struct ApiProcess(Mutex<Option<Child>>);

fn api_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../api")
}

fn python_bin() -> PathBuf {
    if let Ok(explicit) = std::env::var("GAUGES_PYTHON") {
        return PathBuf::from(explicit);
    }
    let venv = api_dir().join(".venv/bin/python");
    if venv.exists() {
        return venv;
    }
    PathBuf::from("python3.12")
}

fn wait_for_port(port: u16) -> Result<(), String> {
    // The ready line is printed while the database is opening, before the socket accepts.
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut last = String::from("connection refused");
    while Instant::now() < deadline {
        match TcpStream::connect_timeout(&addr, Duration::from_millis(200)) {
            Ok(_) => return Ok(()),
            Err(err) => last = err.to_string(),
        }
        thread::sleep(Duration::from_millis(40));
    }
    Err(format!(
        "API not accepting connections on 127.0.0.1:{port} ({last})"
    ))
}

fn spawn_api(app: &AppHandle) -> Result<(Child, u16), String> {
    let api = api_dir();
    let mut cmd = Command::new(python_bin());
    cmd.args(["-m", "app.desktop"])
        .current_dir(&api)
        .env("GAUGES_DESKTOP", "1")
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    if cfg!(debug_assertions) {
        cmd.env("GAUGES_PORT", "8000");
    } else if let Ok(res) = app.path().resource_dir() {
        let ui = res.join("ui");
        let nested = res.join("resources/ui");
        if ui.is_dir() {
            cmd.env("GAUGES_UI_DIR", ui);
        } else if nested.is_dir() {
            cmd.env("GAUGES_UI_DIR", nested);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start API ({}). Run desktop/setup.sh first.", e))?;
    let stdout = child.stdout.take().ok_or("API stdout missing")?;
    let (tx, rx) = std::sync::mpsc::channel::<u16>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut sent = false;
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if !sent {
                if let Some(rest) = line.strip_prefix("GAUGES_READY port=") {
                    if let Ok(port) = rest.trim().parse::<u16>() {
                        let _ = tx.send(port);
                        sent = true;
                    }
                }
            }
            eprintln!("[api] {line}");
        }
    });
    let port = rx
        .recv_timeout(Duration::from_secs(120))
        .map_err(|_| "API did not become ready (GAUGES_READY). Run desktop/setup.sh and check Python venv.")?;
    if let Err(err) = wait_for_port(port) {
        let _ = child.kill();
        return Err(err);
    }
    Ok((child, port))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let (child, port) = spawn_api(&handle)?;
            app.manage(ApiProcess(Mutex::new(Some(child))));
            if let Some(win) = app.get_webview_window("main") {
                if !cfg!(debug_assertions) {
                    let url = Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|err| err.to_string())?;
                    win.navigate(url).map_err(|err| err.to_string())?;
                }
                win.show().map_err(|err| err.to_string())?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Gauge.S Track Analyzer");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            if let Some(state) = app_handle.try_state::<ApiProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}
