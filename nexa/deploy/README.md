# Local native Bridge deployment

Owner: Jillur Rahman / NexaLance

This directory is the versioned deployment source for the local production service. The portable kit is a historical setup reference; the installed `omni-ctl` command prefers `~/Developer/OmniRoute/nexa/deploy/omni-updater.sh`.

## Runtime layout

- Source: `~/Developer/OmniRoute`, clean `nexalance` branch.
- Replaceable package prefix: `~/.omniroute-runtime`.
- Persistent database, environment and CA: `~/.omniroute-local`.
- Archives, isolated package smoke and retained runtime prefixes: `~/.omniroute-builds`.
- Service: user LaunchAgent `com.nexalance.omniroute`, HTTP `127.0.0.1:28128`.
- Native ingress: system LaunchDaemon `com.nexalance.omniroute-native-ingress`, TCP `127.0.0.1:443` and `[::1]:443`. `omni-bind.pl` creates the sockets as the non-root Local application user, binds as root, and runs the forwarder as nobody. This preserves macOS wildcard nginx coexistence in either startup order.
- Decrypting Bridge: `127.0.0.1:8443`, existing trusted CA and selected Claude host.

Install the versioned local command with `bash "$HOME/Developer/OmniRoute/nexa/deploy/install-local-command.sh"`. This preserves the previous HOME command or symlink and leaves the portable T7 script intact. Stock npm replacement and reinstall over an existing prefix are rejected by this entry point.

Install the ingress helper once with the owner's administrator password:

```sh
sudo /bin/bash "$HOME/Developer/OmniRoute/nexa/deploy/install-native-ingress.sh"
```

The installer does not trust a new certificate or change account credentials. Re-running it preserves the prior installed helper. The helper reads only the public TLS ClientHello hostname. It routes exactly `api.anthropic.com` to the Bridge and sends other loopback TLS names to the original Local wildcard listener through `127.0.0.2:443`. It forwards every TLS byte unchanged; when the Bridge listener is unavailable it resolves the original vendor using public DNS and forwards untouched TLS there. This direct path uses the native account's quota.

## Start, Stop and recovery

Use `http://omni.local/dashboard/tools/agent-bridge`. Only Claude Code is selected. Existing model mappings point each native model ID to the same `cc/` model. Compression is disabled.

Explicit Start/Stop is persisted in `mitm/runtime-intent.json`. An enabled listener recovers after service restart only when its hosts entry, trusted CA and internal router key already exist. Recovery never silently installs another CA or adds DNS entries. An explicit Stop stays stopped after service restart.

Administrator passwords are held only in process memory. After restart, Stop may have no password to remove the hosts entry. The native ingress then sends untouched TLS to Anthropic until Start re-enables the listener. `DNS on` in the UI describes the hosts entry; it does not mean a stopped listener still intercepts model requests.

## Update and rollback gates

```sh
omni-ctl update       # stable upstream release, overlay, build and verified deployment
omni-ctl redeploy     # rebuild/redeploy the current source
omni-ctl build-only   # build and isolated smoke, leave live service alone
```

The updater first requires the root-owned hostname-scoped ingress helper; a missing or obsolete helper blocks the update before the live service is stopped. It checks a clean source tree and patch applicability before touching the live prefix. Build validation includes core typecheck, measured full-scope TypeScript ratchet, Bridge/security regressions, release build and package policy. The inherited v3.8.51 full-scope TypeScript backlog is documented separately; this is not a zero-error claim.

The archive gate rejects missing native transport/recovery/event-stream files and the POSIX client-socket startup bug. An isolated installed prefix uses a cloned database and random auxiliary ports. Authenticated management/catalog, a real Opus request and CORS isolation must pass before promotion. Live acceptance checks the actual native ingress and backend with certificate validation enabled, not just `/healthz`.

Promotion retains the entire previous runtime prefix. Failure stops the candidate, preserves it, restores the old prefix and restores the pre-deployment SQLite snapshot. The candidate's database/WAL files are kept privately for recovery. A snapshot cannot preserve writes made after it was taken; the retained failed database is the source for recovering those writes. Open database handles block restoration rather than replacing an active database.

No updater path deletes old archives, snapshots, rejected runtimes or build evidence. Cleanup is a separate owner operation. Desktop shell rebuild is best effort and retains the installed shell when it fails. This workflow does not alter the native Claude Desktop bundle or native Claude account/history.

## Useful verification

The versioned final Bengali report is `../docs/AGENT-BRIDGE-PRODUCTION-HANDOFF-2026-10-02.md`; the credential-free frozen acceptance record and repeatable native concurrency harness are in `../qa/`. The record names the tested production code SHA. A later documentation/tooling commit does not mean the deployed executable has changed; inspect `dist/BUILD_SHA` and the verified archive before reporting a new deployment.

`bridge-upstream-dns.cjs` is the versioned source of the existing DATA_DIR shim loaded through `NODE_OPTIONS`; it keeps provider requests on public DNS while native clients use the local hosts route. Its bytes match the installed shim. The updater preserves the existing DATA_DIR file and secret environment. `../config/agent-bridge.env.example` records only public settings and an example absolute path; never overwrite the secret `.env` with this example. Recover a missing shim from this source with a backup and verify package/live TLS before acceptance.

```sh
node "$HOME/Developer/OmniRoute/nexa/deploy/bridge-gate.mjs" live
node "$HOME/Developer/OmniRoute/nexa/deploy/bridge-gate.mjs" package /absolute/path/to/omniroute-version.tgz
node --test "$HOME/Developer/OmniRoute/nexa/deploy/native-ingress.test.mjs"
python3 "$HOME/Developer/OmniRoute/nexa/tests/test_database_rollback.py"
```

The local gate requires the configured 443/8443 layout. New vendor endpoints, model IDs or native protocols need compatibility verification. Cloud execution features and identical output quality are outside this transport acceptance claim. Further full Mac reboot acceptance remains distinct from the tested service restart recovery.

## Local router coexistence and cached client DNS

The installer now retains the user-owned inherited-socket design introduced by the portable Local repair. It installs its own root-owned `omni-bind.pl` beside the ingress, so a later ingress reinstall cannot revert to root-owned sockets that block Local nginx. Its default owner is `SUDO_USER`; pass the Local application's non-root username as the first argument when installing from a root shell. It refreshes macOS DNS after loading the daemon. Installation remains an administrator operation and can interrupt active connections.

The enabled-Bridge live gate also checks the normal operating-system lookup for `api.anthropic.com`. Every returned address must be `127.0.0.1` or `::1`; an explicit loopback TLS probe alone is insufficient. The earlier acceptance record describes the old gate and is retained as historical evidence. If hosts entries exist but public addresses are returned, refresh the cache in Terminal with `sudo /usr/bin/killall -HUP mDNSResponder`, then verify the live gate. Reopen existing native sessions after a routing transition to discard retained public connections. A successful CLI response alone does not prove interception: confirm the corresponding model request in Bridge logs.

The October 2 evening investigation reproduced native quota rejection with no corresponding intercepted model request, while forced loopback transport health passed. The system lookup still returned a public address. The nine targeted DNS, inherited-descriptor, TLS byte-preservation and Local coexistence regressions pass. End-to-end acceptance remains pending until administrator cache refresh and a native Desktop response are verified. The installed Local helper was preserved; the revised versioned installer has not been applied to the root-owned live files in this investigation.
