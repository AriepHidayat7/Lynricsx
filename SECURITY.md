# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository ("Security" tab → "Report a vulnerability").

Please include a description, reproduction steps, and the Lynricsx version
(`Settings → About`).

This is a volunteer project, so responses are best-effort. We aim to acknowledge
a report within a week and to publish a fix in the next release when one is
warranted.

## Supported versions

Lynricsx is pre-1.0. Only the **latest released version** receives fixes; there
are no maintained older branches.

## Scope

Useful context for what is and is not a security issue here:

- **What Lynricsx does:** reads the current media session through Windows GSMTC,
  makes outbound HTTPS requests to two lyric services, and writes settings,
  a lyrics cache and a diagnostic log into the user's profile.
- **Credentials:** Lynricsx stores no accounts, passwords, API keys or tokens.
  There is nothing for an attacker to steal from its config.
- **Network:** only `api.liriqo-alfarrizi.my.id` and `lrclib.net` are contacted.
  No telemetry is sent. A report about data being sent to an unexpected host is
  in scope.
- **Local data:** settings in `%APPDATA%\com.redlyrics.app`, cache and logs in
  `%LOCALAPPDATA%`. Path traversal in cache or snapshot file naming is in scope.
- **Overlay window:** it is frameless and always-on-top with click-through
  support. A way to make it capture input it should not, or to escape
  click-through, is in scope.

Out of scope:

- Vulnerabilities that require an already-compromised machine or administrator
  rights.
- Issues that only affect the third-party lyric services themselves — report
  those upstream.
- Social-engineering reports and physical access.
- Denial of service from a player sending malformed GSMTC metadata, unless it
  causes a crash that persists after restart (report crashes, but they are
  treated as bugs).

## Dependency hygiene

Frontend and Rust dependencies are pinned by `package-lock.json` and
`src-tauri/Cargo.lock`. Please report a known-vulnerable dependency only if
Lynricsx is actually exposed to it; include the path that makes it reachable.
