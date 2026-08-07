# ElectronIx Tool Store — OTA Setup & Release Procedure

Your operations manual. Part 1 is done once. Part 2 is what you do every release.

Modelled on `INSTRUCTIONS-OTA-SETUP.md` in ElectronIx DNC, with one important
simplification: **there is no signing key to lose.**

---

## The two update channels

They are different animals, and the difference is the whole reason the terminal
is a web app rather than an Android build.

| | **Web terminal** | **Server binary** |
|---|---|---|
| Runs on | every phone and tablet | the store's server PC |
| Updated by | being served a new bundle | `store-cli update --apply` |
| Verified by | the URL itself (content-hashed) | sha256 in `server.json` |
| Operator sees | *"A new version is ready"* → tap Update | nothing; it's a service restart |
| If it goes wrong | reload the page | `mv store-server.old store-server` |
| Signing key | **none** | **none** |

The terminal is embedded in the server binary. Updating the server therefore
updates the UI too — every device picks it up on its next load. There is no
store review, no APK to sideload, and nobody walking the shop floor with a USB
stick.

---

## Part 1 — One-time setup

### 1.1 Create the public releases repo

1. GitHub → **New repository**
2. Name: `electronix-tool-store-releases` · Visibility: **Public** · add a README
3. README: *"Release artifacts for ElectronIx Tool Store. Source code is
   private. Contact ElectronIx for licensing."*
4. Never push code here. Only release assets, published by the workflow.

### 1.2 Create the releases token

The default `GITHUB_TOKEN` cannot create a release on a *different* repository,
so the pipeline needs its own.

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens**
2. Repository access: only `electronix-tool-store-releases`
3. Permissions: **Contents: Read and write**
4. Copy the token into this repo's
   Settings → Secrets and variables → Actions → **`RELEASES_REPO_TOKEN`**

That is the entire secret list. Compare with DNC, which also needs
`TAURI_SIGNING_PRIVATE_KEY` and its password — a web terminal has no installer
to sign, so the "if you lose this key you can never push an update again"
warning simply does not apply here.

### 1.3 Baseline release

Publish `v0.1.0` once (Part 2). Every install from that point on can OTA
forever.

---

## Part 2 — Releasing an update (every time)

1. **Finish and commit your changes.**

2. **Pick the new version** — semver:
   - Bug fix → 0.2.**1**
   - New feature → 0.**3**.0
   - Breaking change to the API, the ADMS protocol, or the schema → **1**.0.0

3. **Bump the version in both manifests and commit.** The pipeline refuses to
   run if the tag does not already match — the tag is only the trigger, the
   committed manifest is the truth:

   ```
   Cargo.toml                        version = "0.3.0"
   crates/store-web/package.json     "version": "0.3.0"
   ```

4. **Tag and push:**

   ```sh
   git tag v0.3.0 && git push origin v0.3.0
   ```

   The workflow runs the full test and lint gate, builds the web bundle and both
   binaries, and publishes a **draft** release with five assets:

   ```
   store-server-0.3.0-linux-x86_64
   store-cli-0.3.0-linux-x86_64
   store-web-0.3.0.tar.gz
   server.json
   SHA256SUMS
   ```

5. **Test it, then publish.** The draft is the staging gate. Update your own
   office machine against it first:

   ```sh
   store-cli update --check --manifest \
     https://github.com/Dinesh417G/electronix-tool-store-releases/releases/download/v0.3.0/server.json
   ```

   When you are happy, click **Publish release** on GitHub — one tap from a
   phone. The moment it is published, every store's next update check sees it.

---

## Part 3 — What a store does

### The server

```sh
store-cli update --check       # what's available; changes nothing
sudo systemctl stop store-server
store-cli update --apply
sudo systemctl start store-server
```

`--apply` downloads, **verifies the sha256 before touching anything**, writes
the new binary alongside the old one, then renames. The previous version is left
at `store-server.old`.

Stop the service first. The command will not guess whether it is safe to swap a
binary out from under a running process.

### The tablets and phones

Nothing. On the next page load the service worker sees a new bundle and shows
*"A new version of the terminal is ready"* with an Update button.

The prompt is deliberate rather than automatic: reloading under an operator who
is halfway through an issue would lose their typing. A wall-mounted terminal that
nobody reloads for weeks re-checks hourly on its own.

---

## Part 4 — Troubleshooting

**`store-cli update --check` says "could not reach"**
The server PC needs outbound HTTPS to github.com. No internet means no OTA —
copy the binary across by hand and `store-cli update --apply --target` it, or
just replace the file.

**"sha256 mismatch — refusing to install"**
The download was truncated or the release was re-uploaded after `server.json`
was written. Nothing was installed; the running binary is untouched. Re-run it.
If it persists, the release is bad — fix and publish a new patch version.

**The server does not come back after an update**

```sh
sudo systemctl stop store-server
mv /path/to/store-server.old /path/to/store-server
sudo systemctl start store-server
```

Under a minute, no network needed. Then send the logs.

**A tablet is stuck on an old version**
It is holding a cached service worker. In the browser: hard-reload, or
Settings → Site settings → Clear data for the store address. If *every* device is
stuck, check that the server is not behind a proxy that caches `index.html` or
`/sw.js` — `store-server` sends `no-store` on both, and a proxy overriding that
is the usual cause.

**A tablet says "Offline" but the shop network is fine**
The event stream is what turns that pill green. Check the server is reachable at
the address the tablet was enrolled with, and that nothing between them is
buffering `text/event-stream` — some proxies do, and that breaks SSE silently.

---

## Part 5 — Why no signing key

DNC signs its installer because it ships a desktop app that Windows will execute
directly; an unsigned update there is a real attack surface, and the key is the
thing standing in front of it.

Here, the update is a binary fetched over HTTPS from a repository you control,
checked against a sha256 published in the same release. The transport is
authenticated by TLS and the content by the digest. Adding a signing key would
add a thing to lose without adding a check that TLS plus the digest does not
already make.

If the threat model ever changes — a mirror you do not control, an air-gapped
customer handing round USB sticks — sign `server.json` and verify it in
`update.rs` before trusting the digest inside. That is the seam to use, and it is
where the check belongs.
