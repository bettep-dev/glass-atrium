// Remote access screen (the Mac's loopback page): open a registration code, list devices, revoke one or all, and the feature's
// on/off and trusted-network state; the remote page never offers it.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { MAC_PAGE_HEADER } from "../src/server/remote/admin-routes.js";
import { REGISTRATION_CODE } from "../src/server/remote/registration-code.js";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../public/src");
const SCREEN_SRC = resolve(SRC, "screens/remote-access.jsx");

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly pageHeader: string | null;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const ui = (await loadScreenModule(resolve(SRC, "ui.jsx"))).UI as Record<string, unknown>;

async function loadScreen(answer: Answer) {
  const sent: SentRequest[] = [];
  const mod = await loadScreenModule(SCREEN_SRC, {
    UI: ui,
    fetch: async (url: string, init: RequestInit = {}) => {
      sent.push({ url, method: init.method ?? "GET", body: init.body, pageHeader: new Headers(init.headers).get(MAC_PAGE_HEADER.NAME) });
      return new Response(JSON.stringify(answer.body), { status: answer.status, statusText: "x" });
    },
  });
  return { mod, sent };
}

const DEVICES_BODY = {
  devices: [
    { id: "3", label: "Pixel 8", createdAt: "2026-11-14T09:12:40.123Z", lastSeenAt: "2026-11-14T13:02:11.456Z" },
    { id: "7", label: "<b>iPad</b>", createdAt: "2026-11-13T21:40:02.001Z", lastSeenAt: "2026-11-14T08:15:59.999Z" },
  ],
  access: { enabled: true, trusted: [{ gateway: "192.168.0.1", hardwareAddress: "a4:2b:b0:11:22:33" }] },
};

describe("the Mac page reads and acts on the remote access routes", () => {
  test("the device list and access state come from one same-origin read", async () => {
    const { mod, sent } = await loadScreen({ status: 200, body: DEVICES_BODY });

    const read = await (mod.readDevicesRA as () => Promise<typeof DEVICES_BODY>)();

    assert.deepEqual(sent.map((entry) => `${entry.method} ${entry.url}`), ["GET /api/remote/devices"]);
    assert.deepEqual(read, DEVICES_BODY);
  });

  test("opening registration posts an empty request and returns the code the Mac shows", async () => {
    const { mod, sent } = await loadScreen({ status: 200, body: { code: "K7QMR2XD" } });

    const code = await (mod.createRegistrationRA as () => Promise<string>)();

    assert.deepEqual(sent, [{ url: "/api/remote/registration", method: "POST", body: undefined, pageHeader: MAC_PAGE_HEADER.VALUE }]);
    assert.equal(code, "K7QMR2XD");
  });

  const calls = [
    { name: "the device read", act: "readDevicesRA", arg: undefined },
    { name: "opening registration", act: "createRegistrationRA", arg: undefined },
    { name: "revoking one device", act: "deleteDeviceRA", arg: "7" },
    { name: "revoking every device", act: "deleteAllDevicesRA", arg: undefined },
  ];
  for (const row of calls) {
    test(`${row.name} carries the page header the admin routes require`, async () => {
      const { mod, sent } = await loadScreen({ status: 200, body: { ...DEVICES_BODY, code: "K7QMR2XD", revoked: 1 } });

      await (mod[row.act] as (id?: string) => Promise<unknown>)(row.arg);

      assert.deepEqual(sent.map((entry) => entry.pageHeader), [MAC_PAGE_HEADER.VALUE], row.name);
    });
  }

  const refusals = [
    { name: "a rate-limited open names the wait", status: 429, error: "too_many_requests", message: /wait a minute/i },
    { name: "an open with no audit row says the code was not opened", status: 503, error: "audit_unavailable", message: /not opened/i },
  ];
  for (const row of refusals) {
    test(row.name, async () => {
      const { mod } = await loadScreen({ status: row.status, body: { error: row.error } });

      await assert.rejects((mod.createRegistrationRA as () => Promise<string>)(), row.message, row.name);
    });
  }

  const revokes = [
    { name: "revoking one device deletes its own route", act: "deleteDeviceRA", arg: "7", status: 200, sent: "DELETE /api/remote/devices/7" },
    { name: "a device already gone counts as revoked", act: "deleteDeviceRA", arg: "7", status: 404, sent: "DELETE /api/remote/devices/7" },
    { name: "revoking every device posts the revoke-all route", act: "deleteAllDevicesRA", arg: undefined, status: 200, sent: "POST /api/remote/devices/revoke-all" },
  ];
  for (const row of revokes) {
    test(row.name, async () => {
      const { mod, sent } = await loadScreen({ status: row.status, body: row.status === 404 ? { error: "device_not_found" } : { revoked: 1 } });

      await (mod[row.act] as (id?: string) => Promise<void>)(row.arg);

      assert.deepEqual(sent.map((entry) => `${entry.method} ${entry.url}`), [row.sent], row.name);
    });
  }
});

describe("the access line states on/off and what keeps the listener closed", () => {
  const rows = [
    { name: "on with trusted networks names their count", access: { enabled: true, trusted: [{}, {}] }, expected: /^On · 2 trusted networks$/ },
    { name: "on with one trusted network uses the singular", access: { enabled: true, trusted: [{}] }, expected: /^On · 1 trusted network$/ },
    { name: "on with no trusted network says the listener stays closed", access: { enabled: true, trusted: [] }, expected: /^On · no trusted network — closed$/ },
    { name: "off says only off", access: { enabled: false, trusted: [{}] }, expected: /^Off$/ },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const { mod } = await loadScreen({ status: 200, body: {} });

      const line = (mod.getAccessLineRA as (access: unknown) => string)(row.access);

      assert.match(line, row.expected, row.name);
    });
  }
});

test("the access card lists each trusted network's gateway and hardware address as text", async () => {
  const { mod } = await loadScreen({ status: 200, body: {} });
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const trusted = [
    { gateway: "192.168.0.1", hardwareAddress: "a4:2b:b0:11:22:33" },
    { gateway: "10.0.1.1", hardwareAddress: "<i>f0:9f:c2:0a:0b:0c</i>" },
  ];

  const tree = renderScreen(React.createElement(mod.AccessCardRA, { access: { enabled: true, trusted } })) as RenderedNode;

  const text = collectText(tree);
  assert.deepEqual(trusted.filter((entry) => !text.includes(`${entry.gateway} · ${entry.hardwareAddress}`)), [], "every entry shown");
  assert.equal(findNodes(tree, (node) => node.type === "i").length, 0, "an entry never parsed as markup");
});

test("each device row shows its label as text and a revoke button named for it", async () => {
  const { mod } = await loadScreen({ status: 200, body: {} });
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };

  const tree = renderScreen(React.createElement(mod.DeviceTableRA, { devices: DEVICES_BODY.devices, onRevoke: () => undefined, pendingId: null })) as RenderedNode;

  const names = findNodes(tree, (node) => node.type === "button").map((node) => node.props["aria-label"]);
  assert.deepEqual(names, ["Revoke Pixel 8", "Revoke <b>iPad</b>"]);
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
  const { mod } = await loadScreen({ status: 200, body: {} });

  assert.equal(vm.runInContext("CODE_WINDOW_MS_RA", mod), REGISTRATION_CODE.WINDOW_MS);
});
