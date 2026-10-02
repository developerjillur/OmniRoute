# Native DNS recovery after Local coexistence repair

Owner: Jillur Rahman. Verified: 2026-10-02, Asia/Dhaka.

## Observed failure and recovery

The Local coexistence repair left correct IPv4 and IPv6 entries in `/etc/hosts`, but the normal macOS client resolver still returned the public Anthropic address. Forced-loopback TLS checks passed while Claude Desktop Code sent requests outside the Bridge and reported its original account's weekly limit. A dashboard health indicator was therefore insufficient evidence of routing.

Recovery used the existing Agent Bridge dashboard: Claude Code **Stop DNS**, the user's administrator-password confirmation, then **Start DNS**. The subsequent normal client lookup returned only `::1` and `127.0.0.1`. The existing native test chat then produced a response; its matching Opus 5.5 request was intercepted at 13:21:19 UTC and completed at 13:21:24 UTC with HTTP 200. A subsequent synthetic turn completed at 13:24:06 UTC. The original signed application, login, account, projects, CA and model mappings were preserved. No application restart was necessary for these requests.

One other request received a thread compatibility 400, followed by a fresh intercepted request and a completed 200 stream. This record does not assert that every thread variation or future version is verified.

The originally failing project chat was also tested without resuming project work or using tools. Its existing 823.2k context remained intact and it returned `EXISTING_SESSION_ROUTE_OK`. The matching intercepted Opus stream completed at 13:25:17 UTC. Its screenshot is `existing-project-native-recovered.png` in the evidence directory. This closes the original-session routing check, in addition to the smaller synthetic chat.

## Durable safeguards in the overlay

- `bridge-gate.mjs` checks the actual normal client resolver in addition to backend and native-ingress TLS. The updater checks client routing before building/promoting a package. Public DNS while Claude routing is enabled fails the gate.
- `refresh-native-dns.mjs` adds a root-only macOS installer recovery path. It preserves all hosts bytes and inode, retains a private backup, triggers an actual file-write event, flushes the resolver and verifies the resulting addresses. A normal resolver restart is a fallback only if reload verification fails. This privileged script was regression-tested using isolated fixtures; it was not the operation used for this live recovery.
- `install-native-ingress.sh` invokes recovery only for already-enabled hosts routing. Disabled routing stays disabled; partial or unexpected Anthropic entries fail rather than being replaced.
- The ingress installer and inherited-socket support preserve Local's socket-owner coexistence design. No global port takeover, TLS-validation bypass, new certificate, account migration, or paid extra usage was enabled.

## Verification and remaining limits

Twelve targeted regressions passed: IPv4/IPv6 routing, inherited sockets, actual byte forwarding, fragmented TLS, unrelated Local host isolation, public fallback, client DNS rejection, hosts preservation and stopped intent. Live gate passed all of `backendTlsVerified`, `ingressTlsVerified`, `nativeIngressScoped`, and `clientDnsVerified`.

After recovery, normal client HTTP checks returned: `omni.local/healthz` 200, `sagrilo-photography.local/wp-admin/` 302 on HTTP and HTTPS, and `acima.local/` 200. The wp-admin redirects are expected login redirects.

The native account's weekly usage display can remain 100% because it describes that signed-in account. Intercepted model traffic uses eligible connected provider accounts. Cloud execution, cloud Routines and original account entitlements are separate. Future app/API changes and actual cold boot still require validation; these safeguards reject detected incompatibility rather than promise every future version will work.

Evidence directory: `/Users/developerjillur/Documents/Codex/2026-10-02/agent-bridge-local-coexistence-1859`. Relevant files: `native-dns-final-response.png`, `live-gate-recovered.json`, `local-sites-recovered.json`, `model-calls-recovered.json`, `targeted-final-tests.log`.

If the same mismatch recurs, inspect normal client DNS before changing any account or app settings. Use Agent Bridge's Claude Code Stop DNS and Start DNS controls, then require a native response and matching interception log. Do not treat a quota display, CLI response alone, or forced localhost health probe as that proof.
