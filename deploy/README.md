# Private deployment

Use the existing home proxy host. Keep provider logins and outbound inference at
home; the UI does not need its own VPS or database. Host names and keys belong in
Fleet's private inventory. The console source repository is public.

## Ports and credentials

| Entry point | Loopback service | Purpose |
| --- | --- | --- |
| Tailscale HTTPS 443 | 8316 | Allowlisted model endpoints, streamed responses and Responses WebSockets |
| Tailscale HTTPS 10443 | 8318 | This built console and authenticated v8 management |
| No direct Serve mapping | 8317 | Existing CLIProxyAPI backend |

Inference keys are passed unchanged to the backend; the filter never adds a
credential or falls back to another provider. The admin boundary requires a
separate management key and rejects cross-origin browser API requests. Management
and the UI are absent from the inference listener. Raw credential downloads are
blocked, including through the upstream credential editor; its controls are
disabled in this fork. OAuth and credential metadata stay with CLIProxyAPI.

The admin key is entered at runtime, never built into HTML or put in a URL.
The upstream **Remember password** option uses reversible browser obfuscation,
not a password vault. It is off by default. Treat the admin browser as trusted;
configuration pages can show client/API keys to an authenticated administrator.
Use normal account sign-in in **Connect accounts**; never paste provider tokens
into a chat or repository. For a remote OAuth callback, follow the upstream UI's
manual callback-paste flow when the browser cannot reach the home loopback port.

## Initial installation

1. Build locally with `bun install --frozen-lockfile && bun run verify`.
2. Confirm the host runs Fleet CLIProxyAPI 8.0.32 on loopback 8317, has Python
   PyYAML, the pinned Node 24 runtime, Tailscale operator access, and persistent
   user services (`loginctl enable-linger` as that host's normal user).
3. Check active work before changing the inference mapping. Copy `gateway.mjs`,
   `gateway-check.mjs`, `install.py`, and `dist/index.html` (renamed to
   `management.html`) into a versioned `~/.local/share/proxy-console/releases/`
   directory on the host. Copy artifacts only, not Fleet's private state.
4. Run the Node checks on the host. Then run `python3 install.py --node PATH`
   from that release directory, using the absolute pinned Node binary path.
5. The installer checks mappings, starts two independent user services, moves
   only inference 443 behind the filter, then enables management and publishes
   only the unused 10443 mapping. It refuses Funnel and conflicting mappings.
   Existing T3 mappings are preserved.
6. Open the printed private HTTPS URL from a Tailscale-connected device. Copy
   `~/.config/proxy-console/management-key` privately into the login field. On
   the management Mac, `ssh YOUR_ALIAS 'cat ~/.config/proxy-console/management-key' | pbcopy`
   copies it without printing it. Clear your clipboard afterward. Do not send it
   in chat. Keep provider OAuth files on the server.

The key is generated with OS randomness, stored mode 0600, and the backend hashes
its own config copy. The pre-console proxy config is backed up privately under
`~/.config/fleet/proxy-before-console.yaml`.

CLIProxyAPI 8.0.32's Linux watcher follows a file inode. The installer writes the
config in place so hot reload can see it. If a prior atomic replacement already
dropped that watch, hot reload will fail verification: keep the filter in place,
check active inference, and restart `fleet-proxy` before publishing the console.
Never expose raw 8317 while management is enabled.

## Ownership and upgrades

`~/.config/fleet/proxy-console-managed` marks the config ownership handoff.
Fleet must preserve `proxy.yaml` after this marker exists, select filtered 8316
for HTTPS 443, and verify admin/client separation in its health check. The console
now owns runtime config edits, while Fleet owns machine and backend versions.
Do not remove the marker merely to rerun provisioning.

The two user services are enabled at boot through lingering. The installer is
initial-install only and refuses to replace running services. For upgrades:

1. Fetch upstream and inspect API compatibility with the pinned backend.
2. Build and verify; copy a new versioned release. Preserve the key/config.
3. Check active work. Update the `ExecStart` paths in the two user service files,
   run `systemctl --user daemon-reload`, and restart only the changed service.
   An admin-only update need not restart the inference filter or backend. An
   inference filter restart interrupts connected streams, so schedule it quietly.
4. Verify unauthenticated admin is 401, worker keys cannot administer, inference
   management paths are 404, quotas refresh, and a real worker Codex turn succeeds.
5. Retain the previous release until verified. To roll back a UI/filter release,
   restore the previous service paths and restart only the affected service.

To fully remove the console, first disable backend management (blank the secret
in its config and verify 404 locally), then remove only Serve 10443, restore 443
to 8317, stop the two user services, and remove the ownership marker. Preserve
provider auth files and T3 mappings. Never run a global Serve reset.

## Scope still requiring real accounts

This console supports the upstream Codex and Claude login/quota flows. A UI build
does not prove a Claude subscription works until its owner signs in. Additional
account affinity, quota exhaustion, reauth, and failover acceptance tests require
at least two real accounts. Quota refresh does not change routing priority. No
automatic earliest-reset policy, billing portal, or subscription purchase/cancel
workflow is added by this fork. Reboot/phone verification must be recorded in
Fleet separately from local tests.
