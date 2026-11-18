fn main() {
    // The Windows icon is embedded into the executable at compile time. Tauri's
    // build script does not declare it as an input, so replacing icon.ico used
    // to leave the stale icon inside the .exe until a full rebuild. Declaring
    // it here forces the linker to re-embed it whenever the icon changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    tauri_build::build()
}
