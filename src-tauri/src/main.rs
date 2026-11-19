// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Legacy `!` key references in models.yml run the shim
    // (`<data_dir>/bin/ompws-key`), which re-invokes this binary here: answer
    // before anything else is initialised.
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some(omp_workspace_lib::KEY_FLAG) => {
            std::process::exit(omp_workspace_lib::run_key_cli(args.next()));
        }
        Some(omp_workspace_lib::AUTOMATION_DAEMON_FLAG) => {
            std::process::exit(omp_workspace_lib::run_automation_daemon());
        }
        _ => {}
    }
    omp_workspace_lib::run()
}
