// Remote listener controller: open only while the trusted-network decision holds, close on any network change,
// pick up a reissued leaf without reopening. Network reads and the listener are fakes → no socket, no command.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";

import { type RemoteListenerHandle, RemoteListenerController, getInterfaceAddress } from "../src/server/remote/controller.js";
import type { RemoteTls } from "../src/server/remote/listener.js";
import type { NetworkIdentity } from "../src/server/remote/network.js";

const HOME: NetworkIdentity = { gateway: "192.168.0.1", hardwareAddress: "50:0e:a5:07:1c:f2", interface: "en1" };
const OFFICE: NetworkIdentity = { gateway: "10.20.0.1", hardwareAddress: "a4:5e:60:11:22:33", interface: "en1" };
const LEAF: RemoteTls = { key: Buffer.from("leaf key A"), cert: Buffer.from("leaf cert A") };

interface Harness {
  readonly controller: RemoteListenerController;
  readonly state: { identity: NetworkIdentity | null; address: string | null; tls: RemoteTls | null; failOpen: boolean };
  readonly opened: { address: string; closed: boolean; tls: RemoteTls[] }[];
}

function buildHarness(trusted: readonly NetworkIdentity[] = [HOME, OFFICE], enabled = true): Harness {
  const state: Harness["state"] = { identity: HOME, address: "192.168.0.10", tls: LEAF, failOpen: false };
  const opened: Harness["opened"] = [];
  const controller = new RemoteListenerController({
    settings: { enabled, trusted },
    readIdentity: async () => state.identity,
    getAddress: () => state.address,
    readTls: async () => {
      if (state.tls === null) throw new Error("ENOENT leaf.pem");
      return state.tls;
    },
    open: async (address, tls): Promise<RemoteListenerHandle> => {
      if (state.failOpen) throw new Error("EADDRNOTAVAIL");
      const record = { address, closed: false, tls: [tls] };
      opened.push(record);
      return {
        close: async () => {
          record.closed = true;
        },
        setTls: (next) => record.tls.push(next),
      };
    },
  });
  return { controller, state, opened };
}

function getOpenAddresses(opened: Harness["opened"]): string[] {
  return opened.filter((record) => !record.closed).map((record) => record.address);
}

describe("opening and closing with the network", () => {
  test("opens once on the interface address of a trusted private network, and repeated checks keep that listener", async () => {
    const { controller, opened } = buildHarness();
    await controller.sync();
    await controller.sync();
    assert.deepEqual(opened.map((record) => record.address), ["192.168.0.10"]);
    assert.deepEqual(getOpenAddresses(opened), ["192.168.0.10"]);
  });

  test("stays closed when the feature is off, the network is untrusted, or the address is not private", async () => {
    const rows = [
      { name: "feature off", build: () => buildHarness([HOME], false) },
      { name: "untrusted network", build: () => buildHarness([OFFICE]) },
      {
        name: "public address",
        build: () => {
          const harness = buildHarness();
          harness.state.address = "203.0.113.7";
          return harness;
        },
      },
    ];
    for (const row of rows) {
      const { controller, opened } = row.build();
      await controller.sync();
      assert.deepEqual(opened, [], row.name);
    }
  });

  test("closes as soon as the network identity cannot be read", async () => {
    const { controller, state, opened } = buildHarness();
    await controller.sync();
    state.identity = null;
    await controller.sync();
    assert.deepEqual(getOpenAddresses(opened), []);
  });

  test("a move to another trusted network closes the old listener and opens one on the new address", async () => {
    const { controller, state, opened } = buildHarness();
    await controller.sync();
    state.identity = OFFICE;
    state.address = "10.20.0.44";
    await controller.sync();
    assert.deepEqual(opened.map((record) => [record.address, record.closed]), [
      ["192.168.0.10", true],
      ["10.20.0.44", false],
    ]);
  });

  test("a failed open leaves it closed without throwing, and the next check opens it", async () => {
    const { controller, state, opened } = buildHarness();
    state.failOpen = true;
    await controller.sync();
    assert.deepEqual(opened, []);
    state.failOpen = false;
    await controller.sync();
    assert.deepEqual(getOpenAddresses(opened), ["192.168.0.10"]);
  });

  test("overlapping checks open a single listener", async () => {
    const { controller, opened } = buildHarness();
    await Promise.all([controller.sync(), controller.sync(), controller.sync()]);
    assert.equal(opened.length, 1);
  });

  test("stop closes the open listener", async () => {
    const { controller, opened } = buildHarness();
    await controller.sync();
    await controller.stop();
    assert.deepEqual(getOpenAddresses(opened), []);
  });
});

describe("the leaf on disk", () => {
  test("a reissued leaf is handed to the open listener without reopening it", async () => {
    const { controller, state, opened } = buildHarness();
    await controller.sync();
    const reissued: RemoteTls = { key: Buffer.from("leaf key B"), cert: Buffer.from("leaf cert B") };
    state.tls = reissued;
    await controller.sync();
    await controller.sync();
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0]?.tls, [LEAF, reissued]);
  });

  test("an unreadable leaf keeps the listener closed, and closes an open one", async () => {
    const closedFromStart = buildHarness();
    closedFromStart.state.tls = null;
    await closedFromStart.controller.sync();
    assert.deepEqual(closedFromStart.opened, []);

    const { controller, state, opened } = buildHarness();
    await controller.sync();
    state.tls = null;
    await controller.sync();
    assert.deepEqual(getOpenAddresses(opened), []);
  });
});

describe("the interface address", () => {
  const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  });
  const ipv6: NetworkInterfaceInfo = { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: "fe80::1/64", scopeid: 4 };
  const rows = [
    { name: "the IPv4 address of the named interface", interfaces: { en1: [ipv6, ipv4("192.168.0.10")], en0: [ipv4("10.0.0.5")] }, expected: "192.168.0.10" },
    { name: "no address when the interface is absent", interfaces: { en0: [ipv4("10.0.0.5")] }, expected: null },
    { name: "no address when the interface has only IPv6", interfaces: { en1: [ipv6] }, expected: null },
    { name: "no address when the only IPv4 is internal", interfaces: { en1: [ipv4("127.0.0.1", true)] }, expected: null },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.equal(getInterfaceAddress(row.interfaces, "en1"), row.expected);
    });
  }
});
