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
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

const LAUNCH_TIMEOUT_MS = 10_000;

/**
 * Launch Chrome and attach to a page.
 *
 * Returns the primitives the tests actually use, so neither of them has to know
 * what a CDP session id is.
 *
 * `port` defaults to 0, which asks the OS for a free one. The port Chrome
 * actually took is read back from `DevToolsActivePort`, the file it writes into
 * the profile directory once it is listening. A fixed port was wrong twice
 * over: three browser tests run one after another in the same CI job, and
 * `chrome.kill()` is a SIGTERM that returns long before the port is released,
 * so a slow-dying Chrome could either block the next launch or — much worse —
 * still be answering, and the next test would drive the previous test's browser
 * without ever knowing.
 */
export async function launchChrome({ port = 0 } = {}) {
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
    // Chrome's own account of why it would not start is the only thing that can
    // explain a failed launch, and `stdio: "ignore"` threw it away. Three
    // pull requests failed on "Chrome did not open a debugging port" with no
    // way to find out which reason it was.
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  // Chrome announces the endpoint on stderr the moment it is listening, and
  // that line is the authoritative answer: it carries the port it really bound
  // and the browser's websocket path. The DevToolsActivePort file in the
  // profile says the same thing, but it is written separately and was observed
  // missing 10 s after "DevTools listening" had already been printed — so the
  // file is the fallback, not the source of truth.
  let stderr = "";
  let announced;
  chrome.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
    announced ??= stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  // A process that has already exited will never write the port file. Without
  // this the loop waits the full timeout to report a browser that died in the
  // first 50 ms, and reports it as a timeout rather than as a crash.
  let exited = null;
  chrome.on("exit", (code, signal) => { exited = { code, signal }; });
  chrome.on("error", (err) => { exited = { code: null, signal: null, err }; });

  const portFile = join(profile, "DevToolsActivePort");
  const started = Date.now();
  let endpoint;
  while (!endpoint && !exited && Date.now() - started < LAUNCH_TIMEOUT_MS) {
    if (announced) {
      endpoint = announced;
      break;
    }
    // Fallback: two lines, the port it bound then the browser's websocket path.
    try {
      const [boundPort, wsPath] = readFileSync(portFile, "utf8").split("\n");
      if (Number(boundPort) > 0 && wsPath?.trim()) {
        endpoint = `ws://127.0.0.1:${Number(boundPort)}${wsPath.trim()}`;
      }
    } catch {
      /* not written yet */
    }
    if (!endpoint) await sleep(100);
  }

  if (!endpoint) {
    chrome.kill();
    const why = exited
      ? exited.err
        ? `could not be spawned: ${exited.err.message}`
        : `exited early (code ${exited.code}, signal ${exited.signal})`
      : `was still running after ${((Date.now() - started) / 1000).toFixed(1)}s but never announced an endpoint, on stderr or in ${portFile}`;
    throw new Error(
      `Chrome never opened a debugging port — it ${why}.\n` +
      `  binary: ${findChrome()}\n` +
      `  stderr: ${stderr.trim() || "(silent)"}`,
    );
  }

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
    // Waits for the process to actually be gone rather than firing a SIGTERM
    // and returning. The next test in the job starts immediately after this
    // resolves, and a Chrome still shutting down is one that still holds its
    // profile directory and its port.
    async close() {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      if (exited) return;
      const dead = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await Promise.race([dead, sleep(5000).then(() => chrome.kill("SIGKILL"))]);
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
