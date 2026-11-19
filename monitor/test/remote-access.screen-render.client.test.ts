// Remote access screen (the Mac's loopback page): every state the spec draws, its words, the confirms that widen or end access,
// and the Mac-only routes it calls; the remote page never offers it.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { CA_DOWNLOAD, CONFIRM_HEADER, MAC_PAGE_HEADER, REMOTE_ADMIN_PATH } from "../src/server/remote/admin-routes.js";
import { getAttachmentDisposition } from "../src/server/response-headers.js";
import { REGISTRATION_CODE } from "../src/server/remote/registration-code.js";
import { collectText, createStatefulReact, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../public/src");
const SCREEN_SRC = resolve(SRC, "screens/remote-access.jsx");
// the file GET /dist/screens/remote-access.js serves to every registered device (npm test → pretest builds it)
const SCREEN_BUNDLE = resolve(SRC, "../dist/screens/remote-access.js");

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly pageHeader: string | null;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

const ui = (await loadScreenModule(resolve(SRC, "ui.jsx"))).UI as Record<string, unknown>;

async function loadScreen(answer: Answer = { status: 200, body: {} }) {
  const sent: SentRequest[] = [];
  const mod = await loadScreenModule(SCREEN_SRC, {
    UI: ui,
    navigator: {},
    File,
    fetch: async (url: string, init: RequestInit = {}) => {
      sent.push({ url, method: init.method ?? "GET", body: init.body, pageHeader: new Headers(init.headers).get(MAC_PAGE_HEADER.NAME) });
      return new Response(JSON.stringify(answer.body), { status: answer.status, statusText: "x", headers: answer.headers });
    },
  });
  return { mod, sent };
}

const ROUTER = "192.168.0.1";
const FINGERPRINT = "9A:3F:1C:07:5E:B2:44:D0:61:0B:F8:2A:93:7C:E5:18:C4:2D:70:AB:06:9E:53:F1:8B:14:D7:3A:6F:20:CE:95";
const SETUP_ON = {
  enabled: true,
  isOffByDevice: false,
  listenReason: "trusted",
  hasRouter: true,
  isNetworkTrusted: true,
  trustedCount: 1,
  isAnswering: true,
  hostName: "studio-mac.local",
  address: "192.168.0.12",
  port: 16146,
  deviceLimit: 10,
  fingerprint: FINGERPRINT,
};
const SETUP_OFF = { ...SETUP_ON, enabled: false, listenReason: "disabled", isNetworkTrusted: false, trustedCount: 0, isAnswering: false };
// remote-access-switch.unit.test.ts → the device-off facts row, as getSetupFacts returned it, + the route's fingerprint
const SETUP_OFF_BY_DEVICE = {
  enabled: false,
  isOffByDevice: true,
  listenReason: "disabled",
  hasRouter: true,
  isNetworkTrusted: true,
  trustedCount: 1,
  isAnswering: false,
  hostName: "owner-mac.local",
  address: "192.168.0.24",
  port: 16443,
  deviceLimit: 10,
  fingerprint: FINGERPRINT,
};
const DEVICES = [
  { id: "3", label: "Minji's iPhone 15 Pro Max", createdAt: "2026-11-17T08:41:40.123Z", lastSeenAt: "2026-11-17T14:02:11.456Z" },
  { id: "7", label: "<b>iPad</b>", createdAt: "2026-11-02T21:15:02.001Z", lastSeenAt: "2026-11-16T23:48:59.999Z" },
  { id: "9", label: "Living-room tablet (kitchen)", createdAt: "2026-10-28T07:03:12.500Z", lastSeenAt: null },
];
const STEP_TITLES = [
  "Send this Mac's certificate to the device",
  "Check and install the certificate",
  "Turn on trust for the certificate",
  "Open this Mac's address on the device",
  "Enter the code on the device",
];
// key directory (data/remote-access/), its CA and leaf files, a home path, and the commands that make or trust them
const NEVER_IN_BUNDLE = [/remote-access\//, /\b(?:ca|leaf)\.(?:pem|key)\b/, /~\//, /\/Users\//, /glass-atrium remote/, /openssl/, /remote-access-set\.sh/, /add-trusted-cert/, /\bsudo\b/];
// never on the page outside the open confirm: commands, key paths, the router, a hardware address, the Mac's link named as Wi-Fi
const NEVER_ON_PAGE = [/glass-atrium remote/, /ca\.pem/, /openssl/, /~\//, /remote-access\//, new RegExp(ROUTER.replaceAll(".", "\\.") + "(?!\\d)"), /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i, /Wi-Fi/];

type Mod = Record<string, unknown> & { React: { createElement: (type: unknown, props: unknown) => unknown } };

function render(mod: Mod, component: string, props: Record<string, unknown>): RenderedNode {
  return renderScreen(mod.React.createElement(mod[component], props)) as RenderedNode;
}

function renderPage(mod: Mod, read: Record<string, unknown>): { tree: RenderedNode; text: string } {
  const tree = render(mod, "RemoteAccessPageRA", { read, onReload: () => undefined, onDevicesRead: () => undefined });
  return { tree, text: collectText(tree).replace(/\s+/g, " ") };
}

function getButtonNames(tree: RenderedNode): string[] {
  return findNodes(tree, (node) => node.type === "button").map((node) => collectText(node).trim());
}

const ready = (setup: Record<string, unknown>, devices: unknown[] = []) => ({ status: "ready", data: { setup, devices }, error: null, at: "2026-11-17T05:02:00.000Z" });

describe("each state shows its own words, and the on/off act sits on the title line", () => {
  const rows = [
    {
      name: "off, never turned off by a device, before any trust",
      read: ready(SETUP_OFF),
      present: ["Off", "Turn on", "A phone or tablet on the same network can use this monitor, exactly as on this Mac.", "Turn it on to see the steps for connecting a device."],
      absent: ["Turn off", "Connect a device", "Registered devices", "Trusted networks"],
    },
    {
      name: "off on a trusted network shows the trusted count with this network among them",
      read: ready({ ...SETUP_OFF, trustedCount: 2, isNetworkTrusted: true }),
      present: ["Turn on", "Trusted networks: 2 · this Mac's network is one of them"],
      absent: ["Turn off", "Connect a device"],
    },
    {
      name: "off on a network that is not trusted says so in the foot",
      read: ready({ ...SETUP_OFF, trustedCount: 1 }),
      present: ["Turn on", "Trusted networks: 1 · this Mac's network is not one of them"],
      absent: ["is one of them"],
    },
    {
      name: "off by a device says a device turned it off and every device was removed",
      read: ready(SETUP_OFF_BY_DEVICE),
      present: ["Off", "Turn on", "A registered device turned remote access off.", "Every device was removed. Turn it on to connect them again.", "Trusted networks: 1 · this Mac's network is one of them"],
      absent: ["Turn off", "Not answering", "Connect a device", "A phone or tablet on the same network"],
    },
    {
      name: "off with no router read offers no turn-on and says to join a network",
      read: ready({ ...SETUP_OFF, hasRouter: false, trustedCount: 1 }),
      present: ["Off", "This Mac is not on a network.", "Connect it to the network your devices use, then turn remote access on here.", "Trusted networks: 1"],
      absent: ["Turn on", "is one of them", "is not one of them"],
    },
    {
      name: "off with a device row left still lists it",
      read: ready({ ...SETUP_OFF, trustedCount: 1, isNetworkTrusted: true }, DEVICES.slice(0, 1)),
      present: ["Turn on", "Registered devices", "1 of 10", "Minji's iPhone 15 Pro Max", "Trusted networks: 1 · this Mac's network is one of them"],
      absent: ["Turn off", "Connect a device"],
    },
    {
      name: "on with no device opens the five steps and an empty device list",
      read: ready(SETUP_ON),
      present: ["On", "Turn off", "Connect a device", "iPhone or iPad", ...STEP_TITLES, "No device registered", "A device appears here after step 5.", "0 of 10", "https://studio-mac.local:16146", "https://192.168.0.12:16146", "9A 3F 1C 07 5E B2 44 D0", "Open a code", "A device removed earlier starts at step 4.", "Trusted networks: 1 · this Mac's network is one of them"],
      absent: ["Remove all", "Closed on this network"],
    },
    {
      name: "on with devices lists them with one remove each and a remove-all",
      read: ready({ ...SETUP_ON, trustedCount: 2 }, DEVICES),
      present: ["On", "Turn off", "Connect a device", "3 of 10", "Remove all", "Device", "Registered", "Last seen", "Action", "None", "Trusted networks: 2 · this Mac's network is one of them"],
      absent: ["No device registered"],
    },
    {
      name: "on with one device offers its own remove and no remove-all",
      read: ready(SETUP_ON, DEVICES.slice(0, 1)),
      present: ["Turn off", "1 of 10", "Remove"],
      absent: ["Remove all"],
    },
    {
      name: "closed on this network offers the trust row and no steps",
      read: ready({ ...SETUP_ON, listenReason: "untrusted", isNetworkTrusted: false, isAnswering: false, trustedCount: 1 }, DEVICES),
      present: ["Closed on this network", "Turn off", "This Mac is on a network you have not trusted", "Registered devices reach this Mac only on networks you trust.", "Trust this network", "Registered devices", "Trusted networks: 1"],
      absent: ["Connect a device", "is one of them", "is not one of them"],
    },
    {
      name: "not on a network says devices reach the Mac only on a trusted network",
      read: ready({ ...SETUP_ON, listenReason: "identity_unreadable", hasRouter: false, isNetworkTrusted: false, isAnswering: false }),
      present: ["Not on a network", "Turn off", "This Mac is not on a network", "Registered devices reach this Mac only on a trusted network.", "Trusted networks: 1"],
      absent: ["Connect a device", "Trust this network"],
    },
    {
      name: "on but not answering says to refresh and reconnect from step 4",
      read: ready({ ...SETUP_ON, isAnswering: false }),
      present: ["Not answering", "Turn off", "Remote access is on, but this Mac is not answering", "Refresh in a minute. If it stays, turn remote access off and on, then connect each device again from step 4.", "Trusted networks: 1 · this Mac's network is one of them"],
      absent: ["Connect a device"],
    },
    {
      name: "a private-address refusal reads as not answering",
      read: ready({ ...SETUP_ON, listenReason: "address_not_private", isAnswering: false }),
      present: ["Not answering", "Turn off", "Remote access is on, but this Mac is not answering"],
      absent: ["Connect a device"],
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const { mod } = await loadScreen();

      const { tree, text } = renderPage(mod as Mod, row.read);

      const titleActs = getButtonNames(tree).filter((name) => /^Turn (on|off)$/.test(name));
      assert.deepEqual(titleActs, ["Turn on", "Turn off"].filter((act) => row.present.includes(act)), `${row.name}: the title-line act`);
      for (const word of row.present) assert.ok(text.includes(word), `${row.name}: shows "${word}"`);
      for (const word of row.absent) assert.ok(!text.includes(word), `${row.name}: never "${word}"`);
      for (const pattern of NEVER_ON_PAGE) assert.doesNotMatch(text, pattern, row.name);
    });
  }

  test("the five steps are one ordered list in the order they are done", async () => {
    const { mod } = await loadScreen();

    const { tree } = renderPage(mod as Mod, ready(SETUP_ON));

    const lists = findNodes(tree, (node) => node.type === "ol");
    assert.equal(lists.length, 1);
    const items = findNodes(lists[0], (node) => node.type === "li").map((node) => collectText(node));
    assert.deepEqual(items.map((text, i) => text.startsWith(STEP_TITLES[i])), [true, true, true, true, true]);
  });

  test("a missing fingerprint says to refresh before installing, in its place", async () => {
    const { mod } = await loadScreen();

    const { text } = renderPage(mod as Mod, ready({ ...SETUP_ON, fingerprint: null }));

    assert.ok(text.includes("Fingerprint not shown. Refresh this page before you install."));
  });
});

describe("the page mounts the type scale its own text classes take", () => {
  test("every fs-* class on the page has a rule in a style the page renders", async () => {
    const { mod } = await loadScreen();

    const { tree } = renderPage(mod as Mod, ready(SETUP_ON, DEVICES));

    const css = findNodes(tree, (node) => node.type === "style").map((node) => collectText(node)).join("\n");
    const classNames = findNodes(tree, (node) => typeof node.props.className === "string").flatMap((node) => String(node.props.className).split(/\s+/));
    const scaleClasses = new Set(classNames.filter((name) => name.startsWith("fs-")));
    assert.ok(scaleClasses.size > 0, "the page carries type-scale classes");
    for (const name of scaleClasses) assert.match(css, new RegExp(`\\.${name}\\s*\\{`), `.${name} has a rule on the page`);
  });
});

describe("before a read lands, the page offers no act", () => {
  const rows = [
    { name: "the first read shows the loading placeholder", read: { status: "loading", data: null, error: null, at: null }, atom: "LoadingPlaceholder" },
    { name: "a first read that fails shows the region failure with Retry", read: { status: "failed", data: null, error: new Error("HTTP 500 x"), at: null }, atom: "RegionUnavailable" },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const { mod } = await loadScreen();

      const { tree } = renderPage(mod as Mod, row.read);

      assert.equal(findNodes(tree, (node) => node.type === row.atom).length, 1, row.name);
      assert.equal(findNodes(tree, (node) => node.type === "Badge").length, 0, `${row.name}: no status word`);
      assert.deepEqual(getButtonNames(tree).filter((name) => /^Turn (on|off)$/.test(name)), [], `${row.name}: no on/off act`);
    });
  }

  test("a failed read after a good one keeps the last content", async () => {
    const { mod } = await loadScreen();

    const { text } = renderPage(mod as Mod, { ...ready(SETUP_ON), status: "failed", error: new Error("HTTP 500 x") });

    assert.ok(text.includes("Connect a device") && text.includes("Turn off"));
  });
});

describe("the confirms name what they do, with Cancel before the commit", () => {
  const widen = [
    { name: "turning on an untrusted network trusts it in the same act", act: "on", network: { router: ROUTER, link: "wifi", isNetworkTrusted: false }, title: "Turn on remote access?", lead: "This also trusts the network this Mac is on now.", label: "Router of this Mac's Wi-Fi", commit: "Turn on and trust" },
    { name: "turning on a trusted network adds no trust", act: "on", network: { router: ROUTER, link: "wired", isNetworkTrusted: true }, title: "Turn on remote access?", lead: "This Mac is on a network you already trust.", label: "Router of this Mac's wired network", commit: "Turn on" },
    { name: "trusting a network on a link the server cannot tell", act: "trust", network: { router: ROUTER, link: "unknown", isNetworkTrusted: false }, title: "Trust this network?", lead: "This trusts the network this Mac is on now.", label: "Router of this Mac's network", commit: "Trust this network" },
  ];
  for (const row of widen) {
    test(row.name, async () => {
      const { mod } = await loadScreen();

      const tree = render(mod as Mod, "WidenConfirmRA", { act: row.act, network: row.network, isBusy: false, error: null, onCommit: () => undefined, onCancel: () => undefined });
      const text = collectText(tree).replace(/\s+/g, " ");

      for (const word of [row.title, row.lead, row.label, ROUTER, "If “Router” there shows a different number, this Mac is on another network: choose Cancel.", "It does not check who else is on this one, so trust only a network you control, such as your home network."]) {
        assert.ok(text.includes(word), `${row.name}: "${word}"`);
      }
      assert.deepEqual(getButtonNames(tree).filter((name) => name !== ""), ["Cancel", row.commit], row.name);
    });
  }

  const off = [
    { name: "turning off with devices says how many are removed", count: 3, body: "3 registered devices are removed, and this Mac stops answering other devices." },
    { name: "turning off with one device uses the singular", count: 1, body: "1 registered device is removed, and this Mac stops answering other devices. To use it again" },
    { name: "turning off with no device says only that the Mac stops answering", count: 0, body: "This Mac stops answering other devices." },
  ];
  for (const row of off) {
    test(row.name, async () => {
      const { mod } = await loadScreen();

      const tree = render(mod as Mod, "EndConfirmRA", { act: "off", count: row.count, isBusy: false, error: null, onCommit: () => undefined, onCancel: () => undefined });

      assert.ok(collectText(tree).includes(row.body), row.name);
      assert.deepEqual(getButtonNames(tree).filter((name) => name !== ""), ["Cancel", "Turn off"], row.name);
    });
  }

  test("removing every device names the count and the commit", async () => {
    const { mod } = await loadScreen();

    const tree = render(mod as Mod, "EndConfirmRA", { act: "remove-all", count: 3, isBusy: true, error: null, onCommit: () => undefined, onCancel: () => undefined });
    const text = collectText(tree);

    assert.ok(text.includes("Remove all 3 devices?") && text.includes("Each device must be connected again from step 4 before it can open this monitor."));
    assert.deepEqual(getButtonNames(tree).filter((name) => name !== ""), ["Cancel", "Removing…"]);
  });

  test("a failed act shows its sentence as an alert inside the dialog", async () => {
    const { mod } = await loadScreen();

    const tree = render(mod as Mod, "EndConfirmRA", { act: "off", count: 0, isBusy: false, error: { text: "Remote access is still on. Try again.", detail: "HTTP 500 x" }, onCommit: () => undefined, onCancel: () => undefined });

    const alerts = findNodes(tree, (node) => node.props.role === "alert").map((node) => collectText(node));
    assert.ok(alerts.some((text) => text.includes("Remote access is still on. Try again.")));
  });
});

describe("step 5 shows one code at a time and what became of it", () => {
  const base = { count: 0, limit: 10, onOpen: () => undefined };
  const rows = [
    { name: "at rest it offers to open a code", state: { status: "idle" }, present: ["Open a code"], absent: ["One use"] },
    { name: "while opening the button says so", state: { status: "opening" }, present: ["Opening…"], absent: ["Open a code"] },
    { name: "an open code shows in two groups of four with its time and a new-code button", state: { status: "open", code: "K7QM4XZP", expiresAt: "2026-11-17T05:07:00.000Z" }, present: ["K7QM 4XZP", "One use · valid until", "Open a new code"], absent: ["expired"] },
    { name: "an expired code gives way to the expired line", state: { status: "expired" }, present: ["That code expired. Open a new code.", "Open a code"], absent: ["K7QM"] },
    { name: "a registered device gives way to the connected line", state: { status: "connected", label: "Minji's iPhone" }, present: ["“Minji's iPhone” is connected.", "Open a code"], absent: ["One use"] },
    { name: "at the device limit the button gives way to the limit line", state: { status: "idle" }, count: 10, present: ["10 of 10 devices registered. Remove one to connect another."], absent: ["Open a code"] },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const { mod } = await loadScreen();

      const text = collectText(render(mod as Mod, "CodeViewRA", { ...base, state: row.state, count: row.count ?? base.count }));

      for (const word of row.present) assert.ok(text.includes(word), `${row.name}: "${word}"`);
      for (const word of row.absent) assert.ok(!text.includes(word), `${row.name}: never "${word}"`);
    });
  }

  const refusals = [
    { name: "a rate-limited open says to wait a minute", status: 429, code: "too_many_requests", text: "Too many codes opened. Wait a minute, then open a code." },
    { name: "an open with no audit row says the monitor could not record it", status: 503, code: "audit_unavailable", text: "No code was opened: the monitor could not record it. Try again in a minute." },
    { name: "any other refusal says no code was opened", status: 500, code: "internal", text: "No code was opened. Try again." },
  ];
  for (const row of refusals) {
    test(row.name, async () => {
      const { mod } = await loadScreen({ status: row.status, body: { error: row.code } });

      const error = await (mod.createRegistrationRA as () => Promise<string>)().catch((caught: unknown) => caught);

      assert.equal((mod.getOpenErrorTextRA as (e: unknown) => string)(error), row.text, row.name);
    });
  }
});

describe("a refused widening act names whether the network moved", () => {
  const rows = [
    { name: "a stale confirm on turn-on says nothing was turned on", act: "on", code: "confirm_stale", text: "The network details were out of date. Nothing was turned on. Check the number again." },
    { name: "a changed network on trust says nothing was trusted", act: "trust", code: "network_changed", text: "The network details were out of date. Nothing was trusted. Check the number again." },
    { name: "a turn-on whose write step ended unnamed says it may or may not be on", act: "on", code: "write_failed", text: "Remote access may or may not be on. Refresh; if wrong, turn it off and on." },
    { name: "a turn-on that threw says it may or may not be on", act: "on", code: "act_failed", text: "Remote access may or may not be on. Refresh; if wrong, turn it off and on." },
    { name: "a trust whose write step ended unnamed says it may or may not be trusted", act: "trust", code: "write_failed", text: "This network may or may not be trusted. Refresh; if wrong, turn remote access off and on." },
    { name: "a trust that threw says it may or may not be trusted", act: "trust", code: "act_failed", text: "This network may or may not be trusted. Refresh; if wrong, turn remote access off and on." },
    { name: "a turn-on whose config was written but not its monitor settings says it may or may not be on", act: "on", code: "env_not_rendered", text: "Remote access may or may not be on. Refresh; if wrong, turn it off and on." },
    { name: "a turn-on written but not applied by this process says it starts at the next restart", act: "on", code: "start_failed", text: "Remote access was turned on, but it starts only when the monitor restarts. Refresh; if you do not want it, turn it off." },
    { name: "a trust written but not applied by this process says it applies at the next restart", act: "trust", code: "start_failed", text: "This network was trusted, but it applies only when the monitor restarts. Refresh; if you do not want it, turn remote access off." },
    { name: "any other turn-on failure says it was not turned on", act: "on", code: "keys_not_created", text: "Remote access was not turned on. Try again." },
    { name: "any other trust failure says it was not trusted", act: "trust", code: "network_unreadable", text: "This network was not trusted. Try again." },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const { mod } = await loadScreen({ status: 409, body: { error: row.code } });

      const error = await (mod.postAccessRA as (act: string) => Promise<unknown>)(row.act).catch((caught: unknown) => caught);

      assert.equal((mod.getWidenErrorTextRA as (act: string, e: unknown) => string)(row.act, error), row.text, row.name);
    });
  }
});

test("a failed act's line folds the server's answer under Details", async () => {
  const { mod } = await loadScreen();
  const detail = "HTTP 500 Internal Server Error: act_failed";

  const tree = render(mod as Mod, "ActErrorRA", { error: { text: "Remote access may or may not be on. Refresh; if wrong, turn it off and on.", detail } });

  assert.ok(collectText(tree).includes(detail));
  assert.ok(findNodes(tree, (node) => node.type === "details").length === 1);
});

describe("after a refused widening act the confirm offers its commit only on a fresh network read", () => {
  const MOVED_ROUTER = "10.0.0.1";
  const SETUP_CLOSED = { ...SETUP_ON, listenReason: "untrusted", isNetworkTrusted: false };
  const ROUTE = { NETWORK: `GET ${REMOTE_ADMIN_PATH.CONFIRM_NETWORK}`, ON: `POST ${REMOTE_ADMIN_PATH.ACCESS_ON}`, TRUST: `POST ${REMOTE_ADMIN_PATH.TRUST}` };
  const OPENED = { status: 200, body: { router: ROUTER, link: "wifi", isNetworkTrusted: false, confirm: "q3Vx0Lr8TfWm1oKcYp2bGA" } };
  const FRESH_CONFIRM = "Zt7nE4sJk9HdQa0uCw6yRg";
  const SETUP_CLOSED_TITLE = "This Mac is on a network you have not trusted";
  const NETWORK_CHANGED_AGAIN = "This Mac's network changed and could not be read again, so nothing was done. Try again.";
  const TURN_ON = { setup: SETUP_OFF, open: "Turn on", commit: "Turn on and trust", route: ROUTE.ON, refusal: { status: 409, body: { error: "confirm_stale" } } };
  const TRUST = { setup: SETUP_CLOSED, open: "Trust this network", commit: "Trust this network", route: ROUTE.TRUST, refusal: { status: 409, body: { error: "network_changed" } } };

  // the page with live hook state over scripted replies; the second network read waits for release()
  async function mountRefused(flow: typeof TURN_ON & { reloaded?: typeof SETUP_ON }) {
    const { react, flushEffects, resetCursor } = createStatefulReact();
    let release: (answer: Answer) => void = () => undefined;
    const replies: Record<string, Array<Answer | Promise<Answer>>> = {
      [ROUTE.NETWORK]: [OPENED, new Promise<Answer>((resolve) => { release = resolve; })],
      [flow.route]: [flow.refusal, { status: 200, body: { outcome: "written" } }],
    };
    const sent: string[] = [];
    const confirms: Array<string | null> = [];
    const page = { sent, confirms, reloads: 0, release: (answer: Answer) => release(answer) };
    const mod = await loadScreenModule(SCREEN_SRC, {
      React: react,
      UI: ui,
      navigator: {},
      File,
      fetch: async (url: string, init: RequestInit = {}) => {
        const route = `${init.method ?? "GET"} ${url}`;
        sent.push(route);
        if (init.method === "POST") confirms.push(new Headers(init.headers).get(CONFIRM_HEADER));
        const answer = await replies[route].shift();
        assert.ok(answer, `an unscripted call: ${route}`);
        return new Response(JSON.stringify(answer.body), { status: answer.status, statusText: "x" });
      },
    });
    const render = (): RenderedNode => {
      resetCursor();
      const props = { read: ready(page.reloads > 0 && flow.reloaded ? flow.reloaded : flow.setup), onReload: () => { page.reloads += 1; }, onDevicesRead: () => undefined };
      const tree = renderScreen(react.createElement(mod.RemoteAccessPageRA, props)) as RenderedNode;
      flushEffects();
      return tree;
    };
    // a press inside the open confirm when one is open, else on the page
    const press = async (name: string) => {
      const tree = render();
      const button = findNodes(getDialog(tree) ?? tree, (node) => node.type === "button" && collectText(node).trim() === name)[0];
      assert.ok(button, `a button named "${name}"`);
      (button.props.onClick as () => void)();
      await new Promise((resolve) => setImmediate(resolve));
    };
    await press(flow.open);
    await press(flow.commit);
    return Object.assign(page, { render, press });
  }

  function getDialog(tree: RenderedNode): RenderedNode | undefined {
    return findNodes(tree, (node) => node.type === "DetailSurface")[0];
  }

  test("while the fresh read is out the commit is held and a press sends nothing", async () => {
    const page = await mountRefused(TURN_ON);

    await page.press("Checking network…");

    assert.deepEqual(page.sent, [ROUTE.NETWORK, ROUTE.ON, ROUTE.NETWORK]);
    assert.ok(!getButtonNames(getDialog(page.render()) as RenderedNode).includes(TURN_ON.commit));
  });

  test("a fresh read with a router puts that router on screen and offers the commit again", async () => {
    const page = await mountRefused(TURN_ON);

    page.release({ status: 200, body: { router: MOVED_ROUTER, link: "wifi", isNetworkTrusted: false, confirm: FRESH_CONFIRM } });
    await new Promise((resolve) => setImmediate(resolve));
    const dialog = getDialog(page.render());

    assert.ok(dialog, "the confirm stays open");
    const text = collectText(dialog);
    assert.ok(text.includes(MOVED_ROUTER) && !text.includes(ROUTER), "the fresh router replaces the earlier one");
    assert.ok(text.includes("The network details were out of date. Nothing was turned on. Check the number again."));
    assert.deepEqual(getButtonNames(dialog).filter((name) => name !== ""), ["Cancel", TURN_ON.commit]);
  });

  const closing = [
    { name: "a fresh read that fails closes the confirm and says nothing was done", flow: TURN_ON, reread: { status: 500, body: { error: "internal" } }, reloads: 0 },
    { name: "a fresh read with no router closes the confirm, says nothing was done and rereads the page", flow: TURN_ON, reread: { status: 200, body: { router: null, link: "unknown", isNetworkTrusted: false, confirm: null } }, reloads: 1 },
    { name: "a trust confirm whose fresh read finds the network trusted closes, says nothing was done and rereads the page", flow: TRUST, reread: { status: 200, body: { router: MOVED_ROUTER, link: "wifi", isNetworkTrusted: true, confirm: FRESH_CONFIRM } }, reloads: 1 },
  ];
  for (const row of closing) {
    test(row.name, async () => {
      const page = await mountRefused(row.flow);

      page.release(row.reread);
      await new Promise((resolve) => setImmediate(resolve));
      const tree = page.render();

      assert.equal(getDialog(tree), undefined, `${row.name}: confirm closed`);
      assert.equal(page.reloads, row.reloads, `${row.name}: page reads`);
      assert.ok(collectText(tree).includes(NETWORK_CHANGED_AGAIN), `${row.name}: "${NETWORK_CHANGED_AGAIN}"`);
    });
  }

  test("a trust confirm closed by a fresh read keeps its words on a page that reread to a state with no attention row", async () => {
    const page = await mountRefused({ ...TRUST, reloaded: SETUP_ON });

    page.release({ status: 200, body: { router: MOVED_ROUTER, link: "wifi", isNetworkTrusted: true, confirm: FRESH_CONFIRM } });
    await new Promise((resolve) => setImmediate(resolve));
    const text = collectText(page.render());

    assert.ok(!text.includes(SETUP_CLOSED_TITLE), "the page shows the reread state");
    assert.ok(text.includes(NETWORK_CHANGED_AGAIN));
  });

  test("each commit carries the confirm value of the network read on screen at the press", async () => {
    const page = await mountRefused(TURN_ON);

    page.release({ status: 200, body: { router: MOVED_ROUTER, link: "wifi", isNetworkTrusted: false, confirm: FRESH_CONFIRM } });
    await new Promise((resolve) => setImmediate(resolve));
    await page.press(TURN_ON.commit);

    assert.deepEqual(page.confirms, [OPENED.body.confirm, FRESH_CONFIRM]);
  });

  // the confirm value is spent → a second press could only answer confirm_stale over words the first press may have made false
  const unsettled = [
    { name: "a turn-on that threw", flow: { ...TURN_ON, refusal: { status: 500, body: { error: "act_failed" } } }, notice: "Remote access may or may not be on. Refresh; if wrong, turn it off and on." },
    { name: "a trust whose write step ended unnamed", flow: { ...TRUST, refusal: { status: 500, body: { error: "write_failed" } } }, notice: "This network may or may not be trusted. Refresh; if wrong, turn remote access off and on." },
    { name: "a turn-on written but not applied, on a page reread to on", flow: { ...TURN_ON, refusal: { status: 500, body: { error: "start_failed" } }, reloaded: { ...SETUP_ON, isAnswering: false } }, notice: "Remote access was turned on, but it starts only when the monitor restarts. Refresh; if you do not want it, turn it off." },
    { name: "a trust written but not applied", flow: { ...TRUST, refusal: { status: 500, body: { error: "start_failed" } } }, notice: "This network was trusted, but it applies only when the monitor restarts. Refresh; if you do not want it, turn remote access off." },
  ];
  for (const row of unsettled) {
    test(`${row.name} closes its confirm, rereads the page and keeps its words there`, async () => {
      const page = await mountRefused(row.flow);

      const tree = page.render();

      assert.equal(getDialog(tree), undefined, `${row.name}: confirm closed`);
      assert.equal(page.reloads, 1, `${row.name}: page reread`);
      assert.ok(collectText(tree).includes(row.notice), `${row.name}: "${row.notice}"`);
      assert.deepEqual(page.sent, [ROUTE.NETWORK, row.flow.route], `${row.name}: no fresh network read`);
    });
  }


  test("a confirm cancelled while the fresh read is out stays closed when the read lands", async () => {
    const page = await mountRefused(TURN_ON);

    await page.press("Cancel");
    page.release({ status: 200, body: { router: MOVED_ROUTER, link: "wifi", isNetworkTrusted: false } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(getDialog(page.render()), undefined);
  });
});

describe("a network read never puts a widening confirm where another confirm was pressed", () => {
  const SETUP_CLOSED = { ...SETUP_ON, listenReason: "untrusted", isNetworkTrusted: false };
  const TRUSTING = { status: 200, body: { router: ROUTER, link: "wifi", isNetworkTrusted: false, confirm: "q3Vx0Lr8TfWm1oKcYp2bGA" } };

  // access on over an untrusted network with three devices; every network read waits for release()
  async function mountHeld() {
    const { react, flushEffects, resetCursor } = createStatefulReact();
    let release: (answer: Answer) => void = () => undefined;
    const held = new Promise<Answer>((resolve) => { release = resolve; });
    const sent: string[] = [];
    const mod = await loadScreenModule(SCREEN_SRC, {
      React: react,
      UI: ui,
      navigator: {},
      File,
      fetch: async (url: string, init: RequestInit = {}) => {
        sent.push(`${init.method ?? "GET"} ${url}`);
        const answer = await held;
        return new Response(JSON.stringify(answer.body), { status: answer.status, statusText: "x" });
      },
    });
    const render = (): RenderedNode => {
      resetCursor();
      const props = { read: ready(SETUP_CLOSED, DEVICES), onReload: () => undefined, onDevicesRead: () => undefined };
      const tree = renderScreen(react.createElement(mod.RemoteAccessPageRA, props)) as RenderedNode;
      flushEffects();
      return tree;
    };
    // the page's own button of that name, as a pointer reaching the page would press it
    const press = async (name: string) => {
      const button = findNodes(render(), (node) => node.type === "button" && collectText(node).trim() === name)[0];
      assert.ok(button, `a button named "${name}"`);
      (button.props.onClick as () => void)();
      await new Promise((resolve) => setImmediate(resolve));
    };
    const getTitle = () => findNodes(render(), (node) => node.type === "DetailSurface")[0]?.props.title;
    return { sent, press, getTitle, release: (answer: Answer) => release(answer) };
  }

  for (const opener of ["Turn off", "Remove all"]) {
    test(`${opener} opens nothing while a trust's network read runs`, async () => {
      const page = await mountHeld();
      await page.press("Trust this network");

      await page.press(opener);

      assert.equal(page.getTitle(), undefined, `${opener}: no confirm under the pending read`);
    });
  }

  test("a read that lands while another confirm is open leaves that confirm in place", async () => {
    const page = await mountHeld();
    await page.press("Turn off");
    await page.press("Trust this network");

    page.release(TRUSTING);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual({ sent: page.sent, title: page.getTitle() }, { sent: [`GET ${REMOTE_ADMIN_PATH.CONFIRM_NETWORK}`], title: "Turn off remote access?" });
  });
});

describe("every Mac-only call carries the page header the admin routes require", () => {
  const rows = [
    { name: "the setup read", act: "readSetupRA", arg: undefined, sent: `GET ${REMOTE_ADMIN_PATH.SETUP}` },
    { name: "the device read", act: "readDevicesRA", arg: undefined, sent: `GET ${REMOTE_ADMIN_PATH.DEVICES}` },
    { name: "the confirm's network read", act: "readConfirmNetworkRA", arg: undefined, sent: `GET ${REMOTE_ADMIN_PATH.CONFIRM_NETWORK}` },
    { name: "the certificate read", act: "readCertificateRA", arg: undefined, sent: `GET ${REMOTE_ADMIN_PATH.CERTIFICATE}` },
    { name: "opening a code", act: "createRegistrationRA", arg: undefined, sent: `POST ${REMOTE_ADMIN_PATH.REGISTRATION}` },
    { name: "removing one device", act: "deleteDeviceRA", arg: "7", sent: "DELETE /api/remote/devices/7" },
    { name: "removing every device", act: "deleteAllDevicesRA", arg: undefined, sent: `POST ${REMOTE_ADMIN_PATH.REVOKE_ALL}` },
    { name: "turning on", act: "postAccessRA", arg: "on", sent: `POST ${REMOTE_ADMIN_PATH.ACCESS_ON}` },
    { name: "trusting the network", act: "postAccessRA", arg: "trust", sent: `POST ${REMOTE_ADMIN_PATH.TRUST}` },
    { name: "turning off", act: "postAccessRA", arg: "off", sent: `POST ${REMOTE_ADMIN_PATH.ACCESS_OFF}` },
  ];
  for (const row of rows) {
    test(`${row.name} goes to its own route with the header and no body`, async () => {
      const { mod, sent } = await loadScreen({
        status: 200,
        body: { ...SETUP_ON, devices: [], code: "K7QM4XZP", revoked: 1, outcome: "written" },
        headers: { "content-disposition": getAttachmentDisposition(CA_DOWNLOAD.FILE_NAME) },
      });

      await (mod[row.act] as (arg?: string) => Promise<unknown>)(row.arg);

      assert.deepEqual(sent.map((entry) => `${entry.method} ${entry.url}`), [row.sent], row.name);
      assert.deepEqual(sent.map((entry) => [entry.pageHeader, entry.body]), [[MAC_PAGE_HEADER.VALUE, undefined]], row.name);
    });
  }

  test("the certificate file takes the name the download's header carries", async () => {
    const name = "Studio Mac CA (2026).pem";
    const { mod } = await loadScreen({ status: 200, body: {}, headers: { "content-disposition": getAttachmentDisposition(name) } });

    const file = await (mod.readCertificateRA as () => Promise<File>)();

    assert.equal(file.name, name);
  });

  test("a certificate download with no file name in its header is a failed read", async () => {
    const { mod } = await loadScreen({ status: 200, body: {} });

    await assert.rejects((mod.readCertificateRA as () => Promise<File>)());
  });

  test("a device already gone counts as removed", async () => {
    const { mod } = await loadScreen({ status: 404, body: { error: "device_not_found" } });

    await (mod.deleteDeviceRA as (id: string) => Promise<void>)("7");
  });
});

test("the fingerprint reads as four lines of eight pairs that rejoin to the server's value", async () => {
  const { mod } = await loadScreen();

  const lines = (mod.formatFingerprintRA as (value: string) => string[])(FINGERPRINT);

  assert.deepEqual([...lines].map((line) => line.split(" ").length), [8, 8, 8, 8]);
  assert.equal(lines.join(" ").replaceAll(" ", ":"), FINGERPRINT);
});

test("each device row shows its label as text and a remove button named for it", async () => {
  const { mod } = await loadScreen();

  const tree = render(mod as Mod, "DeviceTableRA", { devices: DEVICES.slice(0, 2), onRemove: () => undefined, pendingId: null });

  const names = findNodes(tree, (node) => node.type === "button").map((node) => node.props["aria-label"]);
  assert.deepEqual(names, ["Remove Minji's iPhone 15 Pro Max", "Remove <b>iPad</b>"]);
  assert.ok(collectText(tree).includes("<b>iPad</b>"), "label rendered as literal text");
  assert.equal(findNodes(tree, (node) => node.type === "b").length, 0, "label never parsed as markup");
});

describe("the nav offers remote access only on the Mac's loopback page", () => {
  const rows = [
    { name: "the loopback page lists it", protocol: "http:", isListed: true },
    { name: "the remote page hides it", protocol: "https:", isListed: false },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const app = await loadScreenModule(resolve(SRC, "app.jsx"), {
        UI: { ...ui, installRemoteFetch: () => undefined },
        ReactDOM: { createRoot: () => ({ render: () => undefined }) },
        location: { protocol: row.protocol, hash: "" },
        document: { getElementById: () => null },
      });

      const navIds = (vm.runInContext("NAV_ITEMS", app) as { id: string }[]).map((item) => item.id);

      assert.equal(navIds.includes("remote-access"), row.isListed, row.name);
    });
  }
});

test("the code's validity the Mac page states is the server's own window", async () => {
  const { mod } = await loadScreen();

  assert.equal(vm.runInContext("CODE_WINDOW_MS_RA", mod), REGISTRATION_CODE.WINDOW_MS);
});

test("the served screen bundle carries no key-directory path and no command string", () => {
  const bundle = readFileSync(SCREEN_BUNDLE, "utf8");

  for (const pattern of NEVER_IN_BUNDLE) assert.doesNotMatch(bundle, pattern);
});
