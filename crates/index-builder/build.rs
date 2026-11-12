use std::{env, fs, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-changed=unicode-tables.mjs");
    let output = Command::new("node")
        .arg("unicode-tables.mjs")
        .output()
        .expect("Node.js is required to generate V8-compatible Unicode categories");
    assert!(output.status.success(), "Unicode table generation failed");
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("word-ranges.rs"),
        output.stdout,
    )
    .unwrap();
}
