// Trusted network guard: the remote listener opens only on a trusted, readable network with a private address, and
// an unreadable identity (missing route, missing or incomplete ARP entry, failed command) means closed.

import test from "node:test";
import assert from "node:assert/strict";

import {
  type CommandRunner,
  type NetworkIdentity,
  getListenDecision,
  getNetworkIdentity,
  isPrivateIPv4,
} from "../src/server/remote/network.js";

const ROUTE_OUTPUT = [
  "   route to: default",
  "destination: default",
  "       mask: default",
  "    gateway: 192.168.45.1",
  "  interface: en1",
  "      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>",
  " recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire",
  "       0         0         0         0         0         0      1500         0 ",
].join("\n");

const ARP_OUTPUT = "? (192.168.45.1) at 50:e:a5:7:1c:f2 on en1 ifscope [ethernet]\n";

const HOME: NetworkIdentity = { gateway: "192.168.45.1", hardwareAddress: "50:0e:a5:07:1c:f2", interface: "en1" };

function createRunner(outputs: { route?: string | Error; arp?: string | Error }): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (file, args) => {
    calls.push([file, ...args]);
    const output = file.endsWith("/route") ? outputs.route : outputs.arp;
    if (output instanceof Error) throw output;
    return output ?? "";
  };
  return { run, calls };
}

test("the identity is the default gateway plus its zero-padded hardware address, read with absolute binaries", async () => {
  const { run, calls } = createRunner({ route: ROUTE_OUTPUT, arp: ARP_OUTPUT });
  assert.deepEqual(await getNetworkIdentity(run), HOME);
  assert.deepEqual(calls, [
    ["/sbin/route", "-n", "get", "default"],
    ["/usr/sbin/arp", "-n", "192.168.45.1"],
  ]);
});

test("an unreadable identity is null", async () => {
  const rows = [
    { name: "no default route", outputs: { route: "route: writing to routing socket: not in table\n", arp: ARP_OUTPUT } },
    { name: "route command fails", outputs: { route: new Error("spawn failed"), arp: ARP_OUTPUT } },
    { name: "missing ARP entry", outputs: { route: ROUTE_OUTPUT, arp: "192.168.45.1 (192.168.45.1) -- no entry\n" } },
    { name: "incomplete ARP entry", outputs: { route: ROUTE_OUTPUT, arp: "? (192.168.45.1) at (incomplete) on en1 ifscope [ethernet]\n" } },
    { name: "ARP entry for another address", outputs: { route: ROUTE_OUTPUT, arp: "? (192.168.45.7) at 50:e:a5:7:1c:f2 on en1 ifscope [ethernet]\n" } },
    { name: "ARP entry on another interface", outputs: { route: ROUTE_OUTPUT, arp: "? (192.168.45.1) at 50:e:a5:7:1c:f2 on en0 ifscope [ethernet]\n" } },
    { name: "arp command fails", outputs: { route: ROUTE_OUTPUT, arp: new Error("timeout") } },
  ];
  for (const row of rows) assert.equal(await getNetworkIdentity(createRunner(row.outputs).run), null, row.name);
});

test("only the three private IPv4 ranges count as private", () => {
  const rows = [
    { address: "10.0.0.1", expected: true },
    { address: "172.16.0.1", expected: true },
    { address: "172.31.255.254", expected: true },
    { address: "172.32.0.1", expected: false },
    { address: "172.15.255.255", expected: false },
    { address: "192.168.45.94", expected: true },
    { address: "192.169.0.1", expected: false },
    { address: "127.0.0.1", expected: false },
    { address: "169.254.10.1", expected: false },
    { address: "100.64.0.1", expected: false },
    { address: "0.0.0.0", expected: false },
    { address: "8.8.8.8", expected: false },
    { address: "fe80::1", expected: false },
    { address: "192.168.1", expected: false },
    { address: "192.168.1.256", expected: false },
  ];
  for (const row of rows) assert.equal(isPrivateIPv4(row.address), row.expected, row.address);
});

test("the listener opens only when on, trusted, readable and private", () => {
  const trusted = [{ gateway: "192.168.45.1", hardwareAddress: "50:0E:A5:07:1C:F2" }];
  const open = { enabled: true, identity: HOME, trusted, address: "192.168.45.94" };
  const rows = [
    { name: "all four hold", input: open, expected: { open: true, reason: "trusted" } },
    { name: "feature off", input: { ...open, enabled: false }, expected: { open: false, reason: "disabled" } },
    { name: "identity unreadable", input: { ...open, identity: null }, expected: { open: false, reason: "identity_unreadable" } },
    { name: "same gateway IP, other router", input: { ...open, identity: { ...HOME, hardwareAddress: "50:0e:a5:07:1c:f3" } }, expected: { open: false, reason: "untrusted" } },
    { name: "same router, other gateway IP", input: { ...open, identity: { ...HOME, gateway: "192.168.45.2" } }, expected: { open: false, reason: "untrusted" } },
    { name: "no trusted networks", input: { ...open, trusted: [] }, expected: { open: false, reason: "untrusted" } },
    { name: "public address", input: { ...open, address: "8.8.8.8" }, expected: { open: false, reason: "address_not_private" } },
    { name: "no address", input: { ...open, address: null }, expected: { open: false, reason: "address_not_private" } },
  ];
  for (const row of rows) assert.deepEqual(getListenDecision(row.input), row.expected, row.name);
});
