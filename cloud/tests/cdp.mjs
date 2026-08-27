// Driving a real Chrome over the DevTools protocol, without a test framework.
//
// Two tests need this — the passkey ceremony and the operator's issue flow —
// and both need the same three things a headless browser gives and `fetch`
// cannot: a real WebAuthn stack, real React state, and the actual click
// handlers the shop floor will be tapping.
//
// Clicks go by visible text rather than coordinates on purpose. A pixel click
// that lands two millimetres off looks exactly like a screen that does not
// work, and this repository has already shipped a screen nothing could reach.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
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
}

/**
 * Launch Chrome and attach to a page.
 *
 * Returns the primitives the tests actually use, so neither of them has to know
 * what a CDP session id is.
 */
export async function launchChrome({ port = 9333 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "cdp-"));
  const chrome = spawn(
    findChrome(),
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let endpoint;
  for (let i = 0; i < 40 && !endpoint; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) endpoint = (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    if (!endpoint) await sleep(250);
  }
  if (!endpoint) throw new Error("Chrome did not open a debugging port");

  const ws = new WebSocket(endpoint);
  let nextId = 1;
  const pending = new Map();

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

  let session;
  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params, sessionId: session }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000);
    });
  };

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  ({ sessionId: session } = await send("Target.attachToTarget", { targetId, flatten: true }));
  await send("Page.enable");
  await send("Runtime.enable");

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "page threw");
    }
    return result.result?.value;
  };

  return {
    send,
    evaluate,
    close() {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      chrome.kill();
    },

    goto: async (url, settle = 2500) => {
      await send("Page.navigate", { url });
      await sleep(settle);
    },

    text: () => evaluate("document.body.innerText"),

    clickText: (needle, tag = "button") =>
      evaluate(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(tag)})]
          .find((e) => (e.textContent || "").trim().toLowerCase()
            .includes(${JSON.stringify(String(needle).toLowerCase())}));
        if (!el) return false;
        el.click();
        return true;
      })()`),

    clickSelector: (selector) =>
      evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
      })()`),

    // React tracks an input's value on the DOM node, so assigning `.value` is
    // invisible to it. The native setter plus a bubbling input event is what a
    // keystroke looks like from React's side.
    fill: (pairs) =>
      evaluate(`(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value").set;
        let filled = 0;
        for (const [selector, value] of ${JSON.stringify(pairs)}) {
          const el = document.querySelector(selector);
          if (!el) continue;
          setter.call(el, value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          filled += 1;
        }
        return filled;
      })()`),
  };
}

/** A tally that prints as it goes, so a hung test still shows how far it got. */
export function tally() {
  const pass = [];
  const fail = [];
  return {
    pass,
    fail,
    ok(m) {
      pass.push(m);
      console.log("  PASS  " + m);
    },
    bad(m) {
      fail.push(m);
      console.log("  FAIL  " + m);
    },
    step(m) {
      console.log("\n" + m);
    },
    report() {
      console.log(`\n${pass.length} passed, ${fail.length} failed`);
      if (fail.length > 0) process.exitCode = 1;
    },
  };
}

export const trim = (s) => (s ?? "").slice(0, 200).replace(/\n/g, " | ");
