// Trusted network guard: the remote listener opens only on a trusted, readable network with a private address, and
// an unreadable identity (missing route, no usable ARP entry and no matching configd record, failed command) means closed.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { logger } from "../src/server/logger.js";
import {
  type CommandRunner,
  type NetworkIdentity,
  getListenDecision,
  getLocalHostName,
  getNetworkIdentity,
  isPrivateIPv4,
  runCommand,
} from "../src/server/remote/network.js";

/** Exits at once, reads no stdin → the child is often gone before the parent's stdin write or shutdown lands. */
const NON_READING_BINARY = "/usr/bin/true";

/**
 * A scheduling race, not a deterministic fault → concurrent batches add the CPU contention that widens it.
 * - Batch of 64 → 192 pipe fds, under the stock macOS soft limit of 256.
 * - Old code (stdin ended, no error listener): this test went red in 4 of 10 runs; the input test below in every run.
 */
const NON_READING_BATCH = 64;
const NON_READING_RUNS = 6_400;

/** Above the 64 KiB pipe buffer → the write cannot complete before the child exits, so EPIPE is certain, not a race. */
const UNREAD_INPUT = "x".repeat(1 << 20);

/** Runs `body`, then one more timer turn for a late stream error; @returns every uncaught exception and unhandled rejection seen. */
async function getProcessFaults(body: () => Promise<void>): Promise<unknown[]> {
  const faults: unknown[] = [];
  const onFault = (fault: unknown): void => void faults.push(fault);
  process.on("uncaughtException", onFault);
  process.on("unhandledRejection", onFault);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.off("uncaughtException", onFault);
    process.off("unhandledRejection", onFault);
  }
  return faults;
}

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

const NO_ARP_ENTRY = new Error("Command failed: /usr/sbin/arp -n 192.168.45.1\n192.168.45.1 (192.168.45.1) -- no entry");

const SERVICE_ID = "6F1C2B0A-3D4E-4F50-8A61-72B3C4D5E6F7";

const CONFIGD_GLOBAL = `<dictionary> {\n  PrimaryInterface : en1\n  PrimaryService : ${SERVICE_ID}\n  Router : 192.168.45.1\n}\n`;

function getConfigdService(input: { interface?: string; signature?: string } = {}): string {
  return [
    "<dictionary> {",
    "  ARPResolvedHardwareAddress : 50:e:a5:7:1c:f2",
    "  ARPResolvedIPAddress : 192.168.45.1",
    `  InterfaceName : ${input.interface ?? "en1"}`,
    `  NetworkSignature : ${input.signature ?? "IPv4.Router=192.168.45.1;IPv4.RouterHardwareAddress=50:e:a5:7:1c:f2"}`,
    "  Router : 192.168.45.1",
    "}",
  ].join("\n");
}

interface RunnerOutputs {
  route?: string | Error;
  arp?: string | Error;
  configd?: { global?: string | Error; service?: string | Error };
}

function createRunner(outputs: RunnerOutputs): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (file, args, input) => {
    calls.push(input === undefined ? [file, ...args] : [file, ...args, input]);
    const output = file.endsWith("/route")
      ? outputs.route
      : file.endsWith("/arp")
        ? outputs.arp
        : input?.includes("/Global/") === true
          ? outputs.configd?.global
          : outputs.configd?.service;
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
    ...[
      { name: "configd names another router", configd: { global: CONFIGD_GLOBAL, service: getConfigdService({ signature: "IPv4.Router=192.168.45.7;IPv4.RouterHardwareAddress=50:e:a5:7:1c:f2" }) } },
      { name: "configd primary service on another interface", configd: { global: CONFIGD_GLOBAL, service: getConfigdService({ interface: "en0" }) } },
      { name: "configd signature without a hardware address", configd: { global: CONFIGD_GLOBAL, service: getConfigdService({ signature: "IPv4.Router=192.168.45.1" }) } },
      { name: "configd has no primary service", configd: { global: "<dictionary> {\n  Router : 192.168.45.1\n}\n", service: getConfigdService() } },
      { name: "configd service id that is not an id", configd: { global: "  PrimaryService : x\nshow Setup:/\n", service: getConfigdService() } },
      { name: "scutil fails", configd: { global: new Error("timeout"), service: getConfigdService() } },
    ].map((row) => ({ name: `no ARP entry and ${row.name}`, outputs: { route: ROUTE_OUTPUT, arp: NO_ARP_ENTRY, configd: row.configd } })),
  ];
  for (const row of rows) assert.equal(await getNetworkIdentity(createRunner(row.outputs).run), null, row.name);
});

test("a gateway arp cannot see is read from configd's record of the same gateway on the same interface", async () => {
  const { run, calls } = createRunner({
    route: ROUTE_OUTPUT,
    arp: NO_ARP_ENTRY,
    configd: { global: CONFIGD_GLOBAL, service: getConfigdService() },
  });
  assert.deepEqual(await getNetworkIdentity(run), HOME);
  assert.deepEqual(calls.slice(2), [
    ["/usr/sbin/scutil", "show State:/Network/Global/IPv4\nquit\n"],
    ["/usr/sbin/scutil", `show State:/Network/Service/${SERVICE_ID}/IPv4\nquit\n`],
  ]);
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

test("the Bonjour host name is the .local name the Host allowlist admits, and an unreadable or unusable one is none", async () => {
  const rows = [
    { name: "local host name, lower-cased", output: "Studio-Mac\n", expected: "studio-mac.local" },
    { name: "command failed", output: new Error("scutil exited 1"), expected: null },
    { name: "empty name", output: "\n", expected: null },
    { name: "name with a character no Host can carry", output: "owner mac\n", expected: null },
  ];
  for (const row of rows) {
    const calls: string[][] = [];
    const run: CommandRunner = async (file, args) => {
      calls.push([file, ...args]);
      if (row.output instanceof Error) throw row.output;
      return row.output;
    };
    assert.equal(await getLocalHostName(run), row.expected, row.name);
    assert.deepEqual(calls, [["/usr/sbin/scutil", "--get", "LocalHostName"]], row.name);
  }
});

test("the real command runner survives a child that exits without reading stdin", async () => {
  const faults = await getProcessFaults(async () => {
    for (let started = 0; started < NON_READING_RUNS; started += NON_READING_BATCH) {
      const outputs = await Promise.all(Array.from({ length: NON_READING_BATCH }, () => runCommand(NON_READING_BINARY, [])));
      assert.deepEqual(new Set(outputs), new Set([""]));
    }
  });
  assert.deepEqual(faults, []);
});

test("an unread stdin write is logged at debug with the command it went to", async () => {
  const debug = mock.method(logger, "debug", () => undefined);
  try {
    await runCommand(NON_READING_BINARY, [], UNREAD_INPUT);
  } finally {
    debug.mock.restore();
  }
  const logged = debug.mock.calls.map((call) => (call.arguments[0] as { file?: string; err?: { code?: string } }));
  assert.deepEqual(logged.map((entry) => [entry.file, entry.err?.code]), [[NON_READING_BINARY, "EPIPE"]]);
});

test("the real command runner survives stdin input its child never reads", async () => {
  const faults = await getProcessFaults(async () => {
    assert.equal(await runCommand(NON_READING_BINARY, [], UNREAD_INPUT), "");
  });
  assert.deepEqual(faults, []);
});
