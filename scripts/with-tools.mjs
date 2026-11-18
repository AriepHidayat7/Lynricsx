// Adds the WinLibs MinGW `windres` to PATH (and `RC`) so the GNU-target Tauri
// build can compile the Windows resource file without administrator rights.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";

const isWindows = platform() === "win32";

export function findWinLibsBin() {
  const roots = [
    join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Microsoft", "WinGet", "Packages"),
    "C:\\Program Files\\WinLibs",
    "C:\\WinLibs",
    "C:\\mingw64",
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const candidates = [join(root, entry, "mingw64", "bin"), join(root, entry, "bin")];
      for (const bin of candidates) {
        if (existsSync(join(bin, "windres.exe"))) return bin;
      }
    }
  }
  return null;
}

/** Returns an environment with cargo + MinGW tools on PATH. */
export function buildEnv() {
  const env = { ...process.env };
  const extra = [];
  const cargoBin = join(homedir(), ".cargo", "bin");
  if (existsSync(cargoBin)) extra.push(cargoBin);
  const nodeBin = join(process.cwd(), "node_modules", ".bin");
  if (existsSync(nodeBin)) extra.push(nodeBin);
  const nodeDir = dirname(process.execPath);
  if (nodeDir) extra.push(nodeDir);
  const winlibs = findWinLibsBin();
  if (winlibs) {
    extra.push(winlibs);
    env.RC = join(winlibs, "windres.exe");
  }
  const sep = isWindows ? ";" : ":";
  env.PATH = [...extra, env.PATH || ""].join(sep);
  return { env, winlibs };
}

/** Ensures the GNU toolchain is the default target on Windows. */
export function ensureGnuDefault() {
  if (!isWindows) return;
  const rustup = join(homedir(), ".cargo", "bin", "rustup.exe");
  if (!existsSync(rustup)) return;
  const list = spawnSync(rustup, ["toolchain", "list"], { encoding: "utf8" });
  const hasGnu = (list.stdout || "").includes("stable-x86_64-pc-windows-gnu");
  const args = hasGnu
    ? ["default", "stable-x86_64-pc-windows-gnu"]
    : ["toolchain", "install", "stable-x86_64-pc-windows-gnu"];
  const res = spawnSync(rustup, args, { stdio: "inherit" });
  if (res.status !== 0) {
    console.warn("[with-tools] could not prepare the GNU Rust toolchain; falling back to the default toolchain.");
  } else if (!hasGnu) {
    spawnSync(rustup, ["default", "stable-x86_64-pc-windows-gnu"], { stdio: "inherit" });
  }
}

function runCli() {
  const raw = process.argv.slice(2);
  if (raw.length === 0) {
    console.error("usage: node scripts/with-tools.mjs <command> [...args]");
    process.exit(1);
  }
  ensureGnuDefault();
  const { env, winlibs } = buildEnv();
  if (winlibs) {
    console.log(`[with-tools] windres: ${join(winlibs, "windres.exe")}`);
  } else {
    console.warn("[with-tools] windres (MinGW/WinLibs) not found; Windows resource compilation will fail.");
  }

  // Invoke the Tauri CLI directly through its JS entry so we never depend on
  // the npm `.cmd` shim (which breaks when spawned with a custom PATH).
  let cmd = raw[0];
  let cmdArgs = raw.slice(1);
  if (cmd === "tauri") {
    const tauriJs = join(process.cwd(), "node_modules", "@tauri-apps", "cli", "tauri.js");
    if (existsSync(tauriJs)) {
      cmd = process.execPath;
      cmdArgs = [tauriJs, ...cmdArgs];
    }
  }

  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit", env });
  process.exit(result.status ?? 1);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) runCli();
