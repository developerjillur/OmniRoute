# Native Agent Bridge update durability

Owner: Jillur Rahman / NexaLance

## Problem

The local 3.8.51 runtime needed native transport fixes after installation. The source build and rollback archives did not include those fixes. Updating could preserve the database and still replace the working Bridge with an incompatible listener.

## Required behavior

- Keep the upstream base pristine and store changes as build-time overlay patches.
- Preserve native model IDs, effort fields, session headers, query parameters and compressed request bodies.
- Return the router's actual status, content type, request ID and retry headers for JSON, SSE and errors.
- Bind the Bridge to the configured loopback port and select the owner of a shared target host explicitly.
- Provision only enabled agents when selected-only mode is configured.
- Persist explicit Start/Stop intent. Recover enabled listeners after service restart without installing a new CA or adding unapproved DNS entries.
- Show actual listener counters and current certificate trust in the dashboard.
- Provide an authenticated local HTTP event stream where the production App Router cannot expose a raw WebSocket socket.
- Build in isolation. Verify the packaged Bridge and the rollback package before stopping the service.
- Verify the actual backend and native TLS ingress after installation; service health alone cannot accept a deployment.
- Keep provider credentials, database, encryption key, certificates and native account/history outside replaceable package files.

## Validation

Synthetic transport fixtures reproduce the original shared-host failure before the change. The fixed fixture covers JSON, SSE, 429, request headers/query, model/effort preservation and gzip/deflate/br/zstd with certificate verification enabled. Runtime-state tests cover counters and persistent Stop intent. Event-stream tests cover snapshot/update and cleanup. Package inspection, isolated smoke, live inference, cold restart and failed-deployment rollback are separate acceptance gates; evidence must record each result.

## Limits

No finite gate can guarantee every future vendor protocol or identical model output quality. New models require supported provider routing. Cloud routines remain tied to their execution account. Additional OAuth accounts require the owner to complete their normal sign-in; credentials must never be copied into this repository.

The local nginx ingress remains a machine deployment concern. Its regeneration and certificate renewal need operational verification, independent of the upstream transport fix.
