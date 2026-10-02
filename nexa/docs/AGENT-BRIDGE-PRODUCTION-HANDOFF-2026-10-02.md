# Agent Bridge: পূর্ণ QA ও স্থায়ী setup handoff

লেখক: Jillur Rahman  
তারিখ: ২০২৬-১০-০২, Asia/Dhaka  
এটি আগের handoff-গুলোর পরবর্তী যাচাইকৃত সংযোজন। Final consolidation-এ T7-এর মূল handoff ও QA documents backup রেখে আপডেট করা হয়েছে; প্রথম setup-এর তথ্য ইতিহাস হিসেবে সংরক্ষিত।

## ১. যাচাইকৃত বর্তমান ফলাফল

OmniRoute Agent Bridge-এর বর্তমান native Claude Code workflow production runtime-এ পরীক্ষা করে ঠিক করা হয়েছে। Final build-এ ১৩টি configured model-এর ১২টিতে পূর্ণ native CLI request সফল। Sonnet 4.5-এর normal pool request সফল হয়নি: একটি connection-কে upstream usage API active-critical weekly limit দেখাচ্ছে, অন্য connection exact model-এ 404 দিচ্ছে। এই exception সমাধান হয়েছে বলা যাবে না। আগে একই model সফল হয়েছিল; quota/availability সময়ের সঙ্গে বদলেছে। একসঙ্গে চারটি পৃথক conversation, তাদের নিজস্ব context resume এবং একটি streaming request বাতিল করার পর বাকি তিনটি stream সম্পন্ন হওয়ার পরীক্ষা সফল। এই ফল নির্দিষ্ট বর্তমান build ও account/provider অবস্থার প্রমাণ; ভবিষ্যৎ app, provider বা model-এর সব পরিবর্তন সফল হবে এমন নিশ্চয়তা নয়।

বর্তমান runtime: OmniRoute `3.8.51`, compiled `BUILD_SHA=f002e7654`; production Node `24.15.0`; native Claude Code `2.1.287`। Runtime code এবং overlay fix worktree-এর tested commit `f002e7654`। Production source branch `nexalance`-এ তার পরে documentation/QA tooling commits আছে; সেগুলো executable code পরিবর্তন করে না। Generic upstream branch `fix/native-agent-bridge-transport`-এর tested commit `ef90346e2`।

## ২. আমরা configuration-এর বাইরে code পরিবর্তন করেছি কি?

হ্যাঁ। শুধু dashboard option বদলালে boot routing, lifecycle, streaming এবং legacy model compatibility-এর সমস্যাগুলো ঠিক হতো না। Generic fixes OmniRoute-এর manager/server/provider executor/cache constraints-এ করা হয়েছে; স্থানীয় customization ও durability `nexa/` overlay/build/deploy স্তরে রাখা হয়েছে। এই QA-তে native Claude app binary, native login, persistent Claude settings, OS hosts বা certificate trust বদলানো হয়নি। UI পরীক্ষা নিজের নতুন No folder Code session-এ হয়েছে; verification view-এর জন্য sidebar collapse করা হয়েছে। আগে অনুমোদিত localhost ingress, CA এবং hosts routing আগের মতো আছে।

সব repository commit-এর author এবং committer Jillur Rahman। স্বাভাবিক commit hooks চালানো হয়েছে; hooks bypass করা হয়নি। Applied overlay-এর source commit করা হয়নি; build/pack শেষে worktree pristine অবস্থায় ফিরেছে।

## ৩. মূল সমস্যা ও সমাধান

| সমস্যা                                                        | সংশোধন ও ফল                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Restart-এর পরে `api.anthropic.com: ECONNREFUSED`              | পূর্বে installed localhost ingress boot helper `443` গ্রহণ করে enabled Bridge-এর `8443`-এ পাঠায়। Bridge off থাকলে original vendor TLS fallback থাকে। বর্তমান helper অপরিবর্তিত; bootstrap race ও routing regression tests পাস।             |
| `8443 already in use`, PID state হারানো বা duplicate listener | shared process state, exact owned Node executable/server path যাচাই, ready marker পাওয়া পর্যন্ত Start সফল না দেখানো এবং প্রকৃত process exit-এর জন্য অপেক্ষা। পাঁচটি concurrent duplicate Start request পুরোনো listener/PID বদলায়নি।        |
| চলমান response হঠাৎ বিচ্ছিন্ন বা JSON মিশে যাওয়া              | raw bytes এবং backpressure অক্ষুণ্ণ রাখা; inspector decoding মূল stream পরিবর্তন করে না; SSE শুরু হয়ে গেলে foreign JSON error append করা বন্ধ।                                                                                             |
| upstream disconnect/cancellation-এ পুরো Bridge দুর্বল হওয়া    | প্রতি-request error/abort cleanup, response/request destroy এবং listener অক্ষত রাখা। ইচ্ছাকৃত upstream DNS failure-এ sanitized `502` এসেছে, listener/PID টিকে ছিল।                                                                         |
| token count generation endpoint-এ চলে যাওয়া                   | `/v1/messages/count_tokens` ও query অপরিবর্তিত রেখে provider count endpoint-এ পাঠানো। Provider-sourced count যাচাইকৃত।                                                                                                                     |
| legacy Claude 4.5-এ unsupported adaptive thinking             | legacy model-এ adaptive injection/manual-to-adaptive remap বন্ধ; আধুনিক model-এর নিয়ম আগের মতো রাখা।                                                                                                                                       |
| native Opus 4.5-এ long-context entitlement error              | supported model-এর eligibility যাচাই এবং client beta negotiation সম্মান করা। অযোগ্য legacy model-এ `context-1m` আর জোর করে যোগ হয় না। পূর্ণ CLI test-এ এই bug ধরা পড়েছিল; minimal API smoke যথেষ্ট ছিল না।                                 |
| native thread/cache marker conflict                           | Thread request-এ server-এর জন্য এক slot reserve করে client marker সর্বোচ্চ তিনটি; final wire serialization-এর আগে limit enforce এবং tool markers-ও budget-এ count করা। অতিরিক্ত marker-এর `400` retry ঠেকানোর regression ও live proof আছে। |
| Inline tool ও Advisor protocol header হারানো                  | native first-party client-এর negotiated beta অক্ষুণ্ণ রাখা; model/context/skills eligibility gates বহাল। Token-count route-এও একই headers ও cancellation পৌঁছায়; original client credentials provider-এ পাঠানো হয় না।                      |
| update-এ installed fix হারিয়ে যাওয়া                           | durable overlay, বাধ্যতামূলক regression suite, archive/source-dist verification, isolated smoke, live TLS gate এবং পূর্ণ runtime/database rollback পথ।                                                                                     |

Archive gate-এর প্রথম candidate token-count source path package-এ না থাকায় reject হয়েছিল। Gate compiled route ও তার header/cancellation contract যাচাইয়ে সংশোধন করা হয়েছে; live runtime ঐ rejected candidate দিয়ে বদলানো হয়নি। Body-dependent header eligibility-ও count path-এ পৌঁছায়। Rejected archive রাখা হয়েছে, final verified archive আলাদা SHA-তে।

## ৪. পূর্ণ test evidence

| যাচাই                                                    | ফল                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Production Bridge Node suite                             | ৫২৮/৫২৮ পাস; fail/skip শূন্য                                                     |
| Bridge UI component suite                                | ২১/২১ পাস                                                                        |
| Generic upstream targeted regression suite               | ৮৯/৮৯ পাস                                                                        |
| Ingress/bootstrap/storage/owned-stop tests               | ১৫/১৫ পাস                                                                        |
| Core typecheck                                           | পাস                                                                              |
| Full repository TypeScript ratchet                       | measured ৫৮৩০ / baseline ৫৮৩০; নতুন error যোগ হয়নি; পুরো repo error-free দাবি নয় |
| Production build ও package policy                        | পাস; compiled SHA এবং packaged source/dist Bridge contract যাচাইকৃত              |
| Managed isolated package install/smoke/deploy            | সফল                                                                              |
| Final native CLI model matrix                            | ১২/১৩ পাস; Sonnet 4.5 quota/availability blocked                                 |
| Final API models/modern efforts/count matrix             | 23/24 পাস; একই Sonnet 4.5 availability exception                                 |
| চার concurrent session + চার context resume              | সব সফল; অন্য conversation-এর marker reply-তে মেশেনি                              |
| এক stream বাতিল + তিন concurrent surviving stream        | সফল; listener PID অক্ষত                                                          |
| Native inline/Advisor token counting                     | provider-sourced count; estimate fallback নয়                                     |
| Actual native CLI Agent tools                            | দুই Agent call সফল; synthetic ফল 99 ও 89 যাচাই                                   |
| Native Desktop parallel Agents                           | app-এ Ran 2 agents, received 2 messages; ফল 99/89 এবং exact marker সফল           |
| Managed update final recheck                             | latest verified build no-op; archive/live TLS gates সফল; service restart হয়নি    |
| Native tool Read/Write, streaming, resume, parallel pair | সফল; শুধু private synthetic workspace ব্যবহার হয়েছে                              |
| Bridge Stop/Start                                        | তিন cycle সফল; explicit Stop recovery timer-এ নিজে চালু হয়নি                     |
| Configuration/database                                   | fingerprint অপরিবর্তিত; SQLite integrity `ok`                                    |

উপরের overlapping suites যোগ করে আলাদা মোট test সংখ্যা দাবি করা যাবে না। Raw private evidence: `/Users/developerjillur/Documents/Codex/2026-10-02/agent-bridge-full-qa-1300`। Tests real requests ব্যবহার করেছে; account quota কিছু খরচ হয়েছে।

## ৫. Native CLI-তে সব configured model

| Model ID                     | Final result                                                |
| ---------------------------- | ----------------------------------------------------------- |
| `claude-fable-5`             | final native CLI সফল                                        |
| `claude-fable-5-1`           | final native CLI সফল                                        |
| `claude-haiku-4-5-20251001`  | final native CLI সফল                                        |
| `claude-opus-4-5-20251101`   | final native CLI সফল                                        |
| `claude-opus-4-6`            | final native CLI সফল                                        |
| `claude-opus-4-7`            | final native CLI সফল                                        |
| `claude-opus-4-8`            | final native CLI সফল                                        |
| `claude-opus-5`              | final native CLI সফল                                        |
| `claude-opus-5-5`            | final native CLI সফল                                        |
| `claude-sonnet-4-5-20250929` | বর্তমান pool-এ quota/availability blocked; final CLI সফল নয় |
| `claude-sonnet-4-6`          | final native CLI সফল                                        |
| `claude-sonnet-5`            | final native CLI সফল                                        |
| `claude-sonnet-5-5`          | final native CLI সফল                                        |

Model alias `sonnet`/`opus`, latest Sonnet ও Opus-এর `low`, `medium`, `high`, `xhigh`, `max` effort options-ও যাচাই হয়েছে। Legacy model-এর সব effort combination এই দাবির অংশ নয়। API matrix-এ requested model ID এবং returned ID মিলেছে; fallback দিয়ে অন্য model-এর success দেখানো হয়নি।

## ৬. একাধিক chat, session ও account

চারটি পৃথক session একসঙ্গে latest Sonnet, latest Opus, Sonnet 4.6 এবং Opus 4.5 দিয়ে চালানো হয়েছে। প্রত্যেকটির আলাদা private marker ও session ID ছিল। সব stream শেষ হয়েছে; চারটির resume নিজস্ব marker ফিরিয়েছে। পরে একটি বড় stream partial content আসার পরে বাতিল করে অন্য তিনটি concurrent stream সম্পন্ন করা হয়েছে; Bridge PID বদলায়নি।

দুটি active Claude OAuth connection আছে। আগের candidate-এ দুই পৃথক provider connection দিয়ে একই conversation resume ও context বজায় থাকা verified হয়েছিল। Final build-এর continuity retest-এ উভয় turn সফল ও native thread বজায় ছিল, কিন্তু provider logs অনুযায়ী quota-eligible একই connection বেছে নেওয়া হয়েছে। তাই final অবস্থায় দুই-account rotation সফল হয়েছে দাবি নয়। এই test-এ child process-এ অস্থায়ী request header দেওয়া হয়েছিল; persistent native settings বদলানো হয়নি। তৃতীয় Claude account এই pool-এ এখনও configured নয়। প্রথম synthetic “private marker” পরীক্ষায় দুই legacy model instruction প্রত্যাখ্যান করেছিল; transport সম্পূর্ণ হয়েছিল। সাধারণ project name দিয়ে পরীক্ষা পুনরায় করা হয়েছে। প্রথম cancellation fixture দীর্ঘ thinking শেষ হওয়া পর্যন্ত অপেক্ষা করছিল; final fixture partial stream content পাওয়া মাত্র ওই test client বন্ধ করে। পুরোনো পরীক্ষার ব্যর্থ assertions evidence-এ সংরক্ষিত।

Final pool-এ Sonnet 4.5-এর exact request ব্যর্থ হয়েছে। অন্য connection-এ direct diagnostic request 200 হলেও তার live usage payload-এ weekly_all is_active=true, severity=critical; percent=92। Normal OmniRoute routing এই upstream explicit blocking state সম্মান করে। Eligible অন্য connection exact model-এ 404 দেয়। Manual usage refresh-এর পরেও সেই active-critical state ছিল; stale cache বলে ধরে নেওয়া ঠিক নয়। Quota guard বা paid extra-usage policy বদলানো হয়নি; model বদলেও সফল দেখানো হয়নি। এই account/model availability exception এখনও খোলা। Automatic quota exhaustion/rotation-এর সব পরিস্থিতির stress test বা unlimited concurrency-এর নিশ্চয়তা দেওয়া হয়নি।

Native GUI-তে আগে response সফল দেখালেও logs-এ inline tool এবং Advisor header বাদ পড়ার কারণে `400` ও retry দেখা গিয়েছিল। এই failure evidence রাখা হয়েছে। Final protocol fix-এর পরে নতুন native GUI turn, app-এর প্রকৃত দুই parallel Agent এবং synthetic tool-count requests আলাদা করে যাচাই করা হয়েছে; corresponding GUI requests সব 200 ছিল। UI success একা যথেষ্ট evidence হিসেবে ধরা হয়নি। প্রথম inline-count synthetic fixture-এ tool block-এর role/order ভুল ছিল; direct provider 400 দিয়ে তা শনাক্ত করেছে। User message-এর পরে system tool-addition message দিয়ে সংশোধিত valid fixture provider-sourced count দিয়েছে। এটি fixture correction, নতুন runtime patch নয়।

## ৭. Original Claude app/account সংরক্ষণ

`claude auth status`: logged in, `claude.ai`, `firstParty`, `max`। Original Claude app-এর deep/strict code signature verification সফল। Native account/history/projects/user workspace মুছে বা migrate করা হয়নি। Test-এর Read/Write শুধু private synthetic files-এ চালানো হয়েছে।

Provider pool বদলানো আর native app-এর account বদলানো আলাদা বিষয়। Native cloud UI/entitlements original login account-এর ওপর থাকতে পারে। একটি স্থানীয় model request সফল হওয়া থেকে Chat, Cowork, সব integration বা সব cloud feature-এর parity প্রমাণ হয় না।

## ৮. Start/Stop ও ports

- OmniRoute service: `127.0.0.1:28128`।
- Agent Bridge: `8443`, selected target `claude-code`।
- Existing root-owned ingress: localhost `443`। SNI `api.anthropic.com`-এর traffic Claude route-এ যায়; অন্য hostname-কে সেই route-এ পাঠায় না।
- Start readiness ও verified TLS-এর পরে active হয়। Stop explicit intent সংরক্ষণ করে।
- Stop-এ `443` helper original vendor TLS-এ fallback করে; default account-এর quota/entitlement আবার প্রযোজ্য। Default inference exhausted account-এ সফল হবে এমন দাবি নয়।
- Start/Stop/deploy চলমান request শেষ করে দিতে পারে। Native app তা stream interruption হিসেবে দেখাতে পারে; update বা restart শান্ত সময়ে করা উচিত।

## ৯. Update durability: সঠিক পথ

Managed dashboard Update বা `omni-ctl update` ব্যবহার করতে হবে। Unmanaged global npm replacement এই tested durability path নয়। Update-triggered workflow-তে overlay applicability, core typecheck, ingress/helper tests, TypeScript ratchet, full Bridge regression, security/inspector tests, production build এবং package policy বাধ্যতামূলক।

Archive gate packaged Bridge source ও dist-এর মিল, lifecycle/readiness/ownership, streaming/error isolation, count endpoint, legacy thinking/context eligibility এবং compiled inspector route যাচাই করে। New package আগে isolated runtime-এ install ও authenticated smoke/inference দিয়ে পরীক্ষা হয়। তারপর consistent SQLite snapshot এবং পূর্ণ installed prefix backup করে promote হয়। Live service health ও `443/8443` TLS ব্যর্থ হলে পূর্ণ পূর্বের runtime/database ফেরানোর পথ আছে।

প্রথম final isolated smoke-এ model catalog 503 হয়েছিল; candidate live-এ promote হয়নি। Same candidate diagnostic পুনরায় catalog/auth/inference/CORS পাস করেছে, তারপর fresh isolated install-সহ managed redeploy সফল হয়েছে। Initial failure log ও rejected candidate retained। Cold catalog startup timeout source-এ আছে, তবে প্রথম 503-এর response body capture না হওয়ায় নিশ্চিত root cause দাবি করা হয়নি।

Latest deploy backup stamp: `20261002-150336`। Runtime backup: `/Users/developerjillur/.omniroute-builds/runtime-backups/20261002-150336`। Private database/config snapshot: `/Users/developerjillur/.omniroute-local/update-backups/20261002-150336`। Verified package: `/Users/developerjillur/.omniroute-builds/3.8.51-f002e7654/omniroute-3.8.51.tgz`।

`.env`, encryption material, provider connections, local DNS shim, existing CA/key, ১৩ mappings ও selected targets preserved। Backups/archives মুছে দেওয়া হয়নি। Future upstream change-এ patch conflict বা gate fail হলে update বন্ধ করে পুরোনো service ধরে রাখা উদ্দেশ্য; নতুন version-এর compatibility হাতে review লাগতে পারে। এটি update-safe fallback, ভবিষ্যতের সব version-এ zero-issue promise নয়। Updater ব্যবহারকারী-triggered; নিজে continuous release install scheduler নয়। Final f002e7654 build-এ 15:26 Dhaka-তে installed omni-ctl update পুনরায় চালানো হয়েছে; final state ok, already running the newest verified build। Archive guard, patch applicability এবং live ingress/backend TLS পাস হয়েছে; no-op হওয়ায় service restart হয়নি।

## ১০. Quality ও latest native app updates

Prompt compression off। Streaming transport bytes preserve করা হয়েছে। Modern effort options সফল। তবে provider executor কিছু headers/system/tool schema/metadata transform করে; native request এবং upstream provider request সম্পূর্ণ byte-identical নয়। এই QA response quality-এর statistical benchmark নয় এবং সব prompt-এ original subscription path-এর সমমানের output নিশ্চয়তা দেয় না।

Native app bundle বা login/update mechanism এই fixes-এ পরিবর্তিত হয়নি। নতুন Claude app/CLI version endpoint, beta headers, model IDs বা streaming contract বদলালে একই gates এবং real native request আবার চালাতে হবে। নতুন native app version install করে এই QA-তে পরীক্ষা করা হয়নি।

## ১১. Routine, scheduled কাজ এবং verification gaps

Mac প্রথমে locked ছিল; পরে live UI access পাওয়া গেছে। Original native account-এর weekly display ১০০% অবস্থায় নিজের আলাদা No folder Code QA session-এ response পাওয়া গেছে। Final build-এর পরে সেই QA conversation resume এবং dashboard Diagnose/Restart যাচাইয়ের ফল accompanying UI evidence-এ আছে। CLI ও backend/component tests-ও করা হয়েছে। Latest full Mac reboot এই QA-তে চালানো হয়নি; boot helper-এর prior installation ও current bootstrap regression/live LaunchAgent restart আলাদা evidence। Scheduled execution end-to-end, সব Desktop Chat/Cowork features, Windows live environment এবং অন্য সব local website browser workflow যাচাই হয়নি।

Default cloud Routine remote runner-এ execute হলে এই Mac-এর localhost Bridge দিয়ে যায় না; original account-এর quota relevant থাকে। Official documentation self-hosted Routine option-ও বর্ণনা করে; এই setup-এর Routine runner integration configured/tested নয়।

Official references: [Claude environment variables](https://code.claude.com/docs/en/env-vars), [Claude Desktop](https://code.claude.com/docs/en/desktop), [Routines](https://code.claude.com/docs/en/routines), [OmniRoute stable release](https://github.com/diegosouzapw/OmniRoute/releases/tag/v3.8.51)।

## ১২. Upstream PR ও review status

[PR #15323](https://github.com/diegosouzapw/OmniRoute/pull/15323): generic native transport/lifecycle, count endpoint, thread cache budget, legacy thinking এবং inline/Advisor/native beta compatibility fixes। Personal nexa deployment/helper configuration upstream PR-এ নেই। PR draft আছে; merge হয়নি। Latest GitHub API-route typecheck ও Semgrep পাস। Heavy required jobs draft হওয়ায় skipped; Gate/CI এবং Gate/Quality logs-এ `draft or unknown PR readiness` আছে। তাই upstream CI green বলা যাবে না।

## ১৩. Troubleshooting ও handoff ব্যবহার

Connection error হলে আগে dashboard server state, live health, Bridge TLS gate, PID ownership ও provider quota পৃথকভাবে দেখুন। `8443` occupied হলে unrelated process kill করবেন না। `401`/entitlement error-এ original native auth এবং provider connection/headers দেখুন; repeated logout দিয়ে session ইতিহাস বদলাবেন না। Mid-response loss হলে ওই request log ও lifecycle/deploy timing তুলনা করুন।

Configuration export/report-এ API keys, OAuth tokens, CA private key, account email বা raw private prompts রাখবেন না। Recovery-এর জন্য বর্তমান verified package, পূর্ণ runtime backup এবং matching database snapshot ধরে রাখুন। Normal updates managed updater দিয়েই করুন। এই follow-up-এর patch শুধু `nexa/` durability changes বহন করে; pristine base-এর version/context অনুযায়ী review/apply করতে হবে।

## ১৪. Final overlay সংরক্ষণ ও পরবর্তী version গ্রহণের নিয়ম

এই পূর্ণ বাংলা report এখন `nexa/docs/AGENT-BRIDGE-PRODUCTION-HANDOFF-2026-10-02.md`-এ versioned। Credential ছাড়া frozen test/build record `nexa/qa/production-acceptance-2026-10-02.json`। Parallel-session QA পুনরায় চালানোর script `nexa/qa/native-concurrency.mjs`; সাহায্য ও prerequisites `nexa/qa/README.md`। Production transport code `f002e7654`-এর; documentation/QA tooling-এর পরবর্তী commit নিজে deployed executable পরিবর্তন করে না। Runtime পরিবর্তন হয়েছে বলতে actual BUILD_SHA ও archive/deploy evidence লাগবে।

OmniRoute update-এর আগে clean source ও ৫৩টি patch applicability যাচাই হয়। তারপর measured core/ratchet/regression, compiled package contract, isolated authentication/catalog/inference/CORS এবং live TLS acceptance প্রয়োজন। কোনও বাধ্যতামূলক gate fail করলে candidate গ্রহণ করা যাবে না। Native Claude app/CLI update vendor-এর স্বাভাবিক পথে আসতে পারে; তার installation OmniRoute updater আটকে দেয় না। তাই নতুন native version-এ model/effort, native headers/count, tools, streaming, চার session/resume/cancellation ও Desktop-এর প্রকৃত Agent কাজ আবার পরীক্ষা করা প্রয়োজন। Fail হলে Bridge Stop-এর verified vendor TLS fallback দিয়ে original account ব্যবহার করা যায়; original quota/entitlement তখন প্রযোজ্য থাকে।

এই setup-এর production acceptance bounded native Code transport-এর জন্য। Sonnet 4.5 availability, final two-account rotation, তৃতীয় OAuth connection, actual scheduled Routine runner, সব Chat/Cowork feature এবং নতুন full Mac reboot এখনও পৃথক acceptance scope। Quality-এর statistical benchmark বা সব ভবিষ্যৎ version-এ zero-error parity দাবি নেই। Backup ও rejected candidates সংরক্ষিত থাকবে। Actual update/deploy request-এর শান্ত সময় বেছে নিতে হবে; active stream চলাকালীন restart continuity নিশ্চিত নয়।
