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

const REISSUED: RemoteTls = { key: Buffer.from("leaf key R"), cert: Buffer.from("leaf cert R") };
const HOUR_MS = 3_600_000;

interface HarnessState {
  identity: NetworkIdentity | null;
  address: string | null;
  hostName: string | null;
  tls: RemoteTls | null;
  failOpen: boolean;
  isLeafDue: boolean;
  failReissue: boolean;
  now: number;
}

interface Harness {
  readonly controller: RemoteListenerController;
  readonly state: HarnessState;
  readonly opened: { address: string; hostName: string | null; closed: boolean; tls: RemoteTls[] }[];
  readonly reissues: { count: number };
}

function buildHarness(trusted: readonly NetworkIdentity[] = [HOME, OFFICE], enabled = true): Harness {
  const state: HarnessState = {
    identity: HOME,
    address: "192.168.0.10",
    hostName: "studio-mac.local",
    tls: LEAF,
    failOpen: false,
    isLeafDue: false,
    failReissue: false,
    now: 0,
  };
  const opened: Harness["opened"] = [];
  const reissues = { count: 0 };
  const controller = new RemoteListenerController({
    settings: { enabled, trusted },
    readIdentity: async () => state.identity,
    readHostName: async () => state.hostName,
    getAddress: () => state.address,
    readTls: async () => {
      if (state.tls === null) throw new Error("ENOENT leaf.pem");
      return state.tls;
    },
    isLeafDue: () => state.isLeafDue,
    reissueLeaf: async () => {
      reissues.count += 1;
      if (state.failReissue) throw new Error("openssl exited 1");
      state.tls = REISSUED;
      state.isLeafDue = false;
    },
    getNow: () => state.now,
    open: async (address, hostName, tls): Promise<RemoteListenerHandle> => {
      if (state.failOpen) throw new Error("EADDRNOTAVAIL");
      const record = { address, hostName, closed: false, tls: [tls] };
      opened.push(record);
      return {
        close: async () => {
          record.closed = true;
        },
        setTls: (next) => record.tls.push(next),
      };
    },
  });
  return { controller, state, opened, reissues };
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

  test("turning off closes the listener and no later check reopens it while the process lives", async () => {
    const { controller, opened } = buildHarness();
    await controller.sync();
    const wasTurnedOff = controller.isTurnedOff;
    await controller.turnOff();
    await controller.sync();
    assert.deepEqual([opened.length, getOpenAddresses(opened), wasTurnedOff, controller.isTurnedOff], [1, [], false, true]);
  });

  test("a Bonjour rename closes the listener and reopens it under the new name", async () => {
    const { controller, state, opened } = buildHarness();
    await controller.sync();
    state.hostName = "studio-mac-2.local";
    await controller.sync();
    assert.deepEqual(opened.map((record) => [record.hostName, record.closed]), [
      ["studio-mac.local", true],
      ["studio-mac-2.local", false],
    ]);
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

describe("reissuing a due leaf", () => {
  test("a due leaf is reissued before the listener opens, which then serves the reissued leaf", async () => {
    const { controller, state, opened, reissues } = buildHarness();
    state.isLeafDue = true;
    await controller.sync();
    assert.deepEqual([reissues.count, opened[0]?.tls], [1, [REISSUED]]);
  });

  test("a leaf falling due on an open listener is reissued and handed over without reopening", async () => {
    const { controller, state, opened } = buildHarness();
    await controller.sync();
    state.isLeafDue = true;
    await controller.sync();
    assert.deepEqual([opened.length, opened[0]?.tls], [1, [LEAF, REISSUED]]);
  });

  test("a failed reissue still opens the listener with the current leaf", async () => {
    const { controller, state, opened } = buildHarness();
    state.isLeafDue = true;
    state.failReissue = true;
    await controller.sync();
    assert.deepEqual(getOpenAddresses(opened), ["192.168.0.10"]);
    assert.deepEqual(opened[0]?.tls, [LEAF]);
  });

  const retryRows = [
    { name: "not retried on a later check of the same network and name", change: (state: HarnessState) => (state.now += 60_000), attempts: 1 },
    { name: "retried an hour later", change: (state: HarnessState) => (state.now += HOUR_MS), attempts: 2 },
    { name: "retried at once when the Wi-Fi address changes", change: (state: HarnessState) => (state.address = "192.168.0.23"), attempts: 2 },
    { name: "retried at once when Bonjour renames the Mac", change: (state: HarnessState) => (state.hostName = "studio-mac-2.local"), attempts: 2 },
  ];
  for (const row of retryRows) {
    test(`a failed reissue is ${row.name}`, async () => {
      const { controller, state, reissues } = buildHarness();
      state.isLeafDue = true;
      state.failReissue = true;
      await controller.sync();
      row.change(state);
      await controller.sync();
      assert.equal(reissues.count, row.attempts);
    });
  }
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
