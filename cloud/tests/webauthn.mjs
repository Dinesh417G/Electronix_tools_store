// Drive the whole passkey ceremony against a real Chrome, with no hardware.
//
// CLAUDE.md §8 makes passkeys the fourth identity source and §13 left the
// ceremony untested — "needs a real device on HTTPS". A CDP virtual
// authenticator is that device: Chrome implements it inside the same WebAuthn
// stack a real security key drives, so `navigator.credentials.create()` and
// `.get()` run for real — challenge, attestation, signature, sign counter.
// What it does not prove is a particular phone's secure enclave or the
// platform's own prompt. localhost is a secure origin, so no HTTPS is needed.
//
// What it checks, in order: the screen renders, registration creates a real
// credential, that credential signs the operator in on the terminal, revoking
// it removes it, and a revoked credential can no longer open a session — which
// is the whole reason the revoke button had to exist.
//
//   STORE_BASE=… STORE_ENROLMENT_SECRET=… DATABASE_URL=… node tests/webauthn.mjs
//
// Chrome is found from CHROME_PATH, or from the usual install locations. There
// is no graceful skip: a gate that quietly does nothing is how §13 ended up
// with five routes nobody had ever run.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";
const SECRET = process.env.STORE_ENROLMENT_SECRET;
const EMP_CODE = process.env.WEBAUTHN_EMP_CODE ?? "E1001";
const PIN = process.env.WEBAUTHN_PIN ?? "1111";
const PORT = Number(process.env.CDP_PORT ?? 9333);

if (!SECRET) {
  console.error("STORE_ENROLMENT_SECRET is required — the browser has to enrol as a terminal first");
  process.exit(1);
}

const CHROME = (() => {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    console.error("no Chrome found. Set CHROME_PATH.");
    process.exit(1);
  }
  return found;
})();

const pass = [];
const fail = [];
const ok = (m) => { pass.push(m); console.log("  PASS  " + m); };
const bad = (m) => { fail.push(m); console.log("  FAIL  " + m); };
const step = (m) => console.log("\n" + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trim = (s) => (s ?? "").slice(0, 200).replace(/\n/g, " | ");

// ── CDP plumbing ────────────────────────────────────────────────────────
let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 30000);
  });
}

let session;
async function evaluate(expression) {
  const result = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    session,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "page threw");
  }
  return result.result?.value;
}

// Click by visible text rather than coordinates: the point is the wiring, and a
// pixel click that misses looks exactly like a screen that does not work.
const clickText = (text, tag = "button") => evaluate(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(tag)})]
    .find((e) => (e.textContent || "").trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
  if (!el) return false;
  el.click();
  return true;
})()`);

const clickSelector = (selector) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.click();
  return true;
})()`);

// React tracks the value on the DOM node, so assigning `.value` is invisible to
// it. The native setter plus a bubbling input event is what a keystroke looks
// like from React's side.
const fill = (pairs) => evaluate(`(() => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  for (const [selector, value] of ${JSON.stringify(pairs)}) {
    const el = document.querySelector(selector);
    if (!el) continue;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return true;
})()`);

const text = () => evaluate("document.body.innerText");
const goto = async (url) => { await send("Page.navigate", { url }, session); await sleep(2500); };

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "webauthn-chrome-"));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    let endpoint;
    for (let i = 0; i < 40 && !endpoint; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        if (res.ok) endpoint = (await res.json()).webSocketDebuggerUrl;
      } catch { /* not up yet */ }
      if (!endpoint) await sleep(250);
    }
    if (!endpoint) throw new Error("Chrome did not open a debugging port");

    ws = new WebSocket(endpoint);
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      const waiter = msg.id && pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", () => reject(new Error("CDP socket failed")));
    });

    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    ({ sessionId: session } = await send("Target.attachToTarget", { targetId, flatten: true }));
    await send("Page.enable", {}, session);
    await send("Runtime.enable", {}, session);

    step("1. a virtual authenticator, standing in for the operator's phone");
    await send("WebAuthn.enable", { enableUI: false }, session);
    const { authenticatorId } = await send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",   // a platform authenticator, as a phone is
        hasResidentKey: true,    // discoverable: sign-in needs no username
        hasUserVerification: true,
        isUserVerified: true,    // the fingerprint "succeeds"
        automaticPresenceSimulation: true,
      },
    }, session);
    ok(`virtual platform authenticator attached (${authenticatorId.slice(0, 8)}…)`);

    step("2. enrol this browser as a terminal, then sign in as the admin");
    await goto(BASE);

    const env = await evaluate(`({
      hasPKC: typeof window.PublicKeyCredential !== "undefined",
      secure: window.isSecureContext,
    })`);
    if (env.hasPKC && env.secure) ok("secure context, WebAuthn available");
    else bad(`WebAuthn unavailable: ${JSON.stringify(env)}`);

    if ((await evaluate('document.querySelectorAll("input").length')) >= 2) {
      await fill([['input[type="password"]', SECRET]]);
      if (await clickText("Enrol this device")) ok("device enrolled");
      else bad("no 'Enrol this device' button");
      await sleep(2000);
    } else {
      ok("device already enrolled");
    }

    // The settings entry is an icon button: the text is a gear glyph and the
    // name lives in aria-label, so matching on text does not find it.
    const openAdmin = async () => {
      await goto(BASE);
      if (!(await clickSelector('button[aria-label="Settings"], button[title="Settings"]'))) {
        await clickText("\u2699");
      }
      await sleep(800);
      await clickText("admin");
      await sleep(1200);
      await fill([
        ['input:not([type="password"])', EMP_CODE],
        ['input[type="password"]', PIN],
      ]);
      await clickText("Sign in");
      await sleep(2000);
      return /Catalog/i.test(await text());
    };

    const openPasskeys = async () => {
      await clickText("Setup");
      await sleep(900);
      const listed = /Passkeys/.test(await text());
      await clickText("Passkeys");
      await sleep(1500);
      return listed;
    };

    if (await openAdmin()) ok("signed in with employee code and PIN");
    else bad("admin console did not open");

    step("3. Setup → Passkeys — the screen that had no way in until today");
    if (await openPasskeys()) ok("Setup lists a Passkeys section");
    else bad("no Passkeys section in Setup");
    const empty = await text();
    if (/No passkey is registered/i.test(empty)) ok("empty state renders before anything exists");
    else bad("unexpected first render: " + trim(empty));

    step("4. register — a real create() ceremony");
    if (!(await clickText("Register this device"))) bad("no 'Register this device' button");
    await sleep(4000);
    const registered = await text();
    if (/Registered\./i.test(registered)) ok("the screen reports it registered");
    else bad("no success notice: " + trim(registered));

    const held = await send("WebAuthn.getCredentials", { authenticatorId }, session);
    if (held.credentials?.length === 1) ok("the authenticator holds one credential — create() really ran");
    else bad(`the authenticator holds ${held.credentials?.length ?? 0} credentials`);

    step("5. sign in with it on the terminal — a real get() ceremony");
    const passkeySignIn = async () => {
      await goto(BASE);
      // The console survives a reload, so getting back to the terminal means
      // signing out of it. Without this the check reads the admin screen and
      // reports "no session opened" for the wrong reason — and step 7 would
      // pass vacuously, which is worse.
      if (/Sign out/.test(await text())) {
        await clickText("Sign out");
        await sleep(1500);
      }
      const onTerminal = /Reader not working|finger on the door reader/i.test(await text());
      if (!onTerminal) bad("could not get back to the terminal: " + trim(await text()));
      await clickText("Reader not working");
      await sleep(900);
      const offered = await clickText("Use fingerprint on this phone");
      await sleep(3500);
      return { offered, body: await text() };
    };

    const signIn = await passkeySignIn();
    if (signIn.offered) ok("the terminal offers the passkey button");
    else bad("no 'Use fingerprint on this phone' button on the manual screen");
    if (/TAKE OUT|PUT IN/i.test(signIn.body)) ok("signed in — the terminal advanced to TAKE OUT / PUT IN");
    else bad("passkey sign-in opened no session: " + trim(signIn.body));

    step("6. revoke it");
    if (await openAdmin()) {
      await openPasskeys();
      await clickText("Revoke");
      await sleep(600);
      if (!(await clickText("Yes, revoke it"))) bad("no confirmation after Revoke");
      await sleep(2000);
      const after = await text();
      if (/No passkey is registered/i.test(after)) ok("the device is gone from the list");
      else bad("still listed after revoke: " + trim(after));
    } else {
      bad("could not get back into the console to revoke");
    }

    step("7. and now it cannot sign in — which is the point of the button");
    const afterRevoke = await passkeySignIn();
    if (/TAKE OUT|PUT IN/i.test(afterRevoke.body)) {
      bad("a REVOKED passkey still opened a session");
    } else {
      ok("the revoked passkey no longer opens a session");
    }
  } finally {
    try { ws?.close(); } catch { /* already gone */ }
    chrome.kill();
  }

  console.log(`\n${pass.length} passed, ${fail.length} failed`);
  if (fail.length > 0) process.exitCode = 1;
}

await main();
