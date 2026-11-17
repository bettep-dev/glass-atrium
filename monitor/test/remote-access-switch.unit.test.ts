// The Mac page's on, off and trust in this process: the shell step writes, the switch applies the settings it wrote.
// Runner: npx tsx --test test/remote-access-switch.unit.test.ts

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";

import type { AccessStepOutcome } from "../src/server/remote/admin-routes.js";
import type { NetworkIdentity } from "../src/server/remote/network.js";
import type { RemoteSettings } from "../src/server/remote/settings.js";
import { type AccessSwitchDeps, RemoteAccessSwitch, runAccessStep } from "../src/server/remote/start.js";
import { deleteDirectory } from "./lib/remove-dir.js";

const HOME_NETWORK = { gateway: "192.168.0.1", hardwareAddress: "a4:2b:b0:11:22:33" };
const OFFICE_NETWORK = { gateway: "10.20.0.1", hardwareAddress: "3c:22:fb:9a:01:7e" };
const OFF: RemoteSettings = { enabled: false, port: 16443, trusted: [] };
const ON: RemoteSettings = { enabled: true, port: 16443, trusted: [HOME_NETWORK] };

/** What the real controller exposes to the switch: open until turned off. */
class StandInController {
  isTurnedOff = false;
  isOpen = true;
  constructor(readonly settings: RemoteSettings) {}
  async turnOff(): Promise<void> {
    this.isTurnedOff = true;
    this.isOpen = false;
  }
  async stop(): Promise<void> {
    this.isOpen = false;
  }
}

interface SwitchCase {
  readonly booted?: RemoteSettings;
  readonly written?: RemoteSettings;
  readonly step?: AccessStepOutcome;
  readonly isDeviceOff?: boolean;
  readonly isOpenFailing?: boolean;
  readonly isReadFailing?: boolean;
  readonly identity?: NetworkIdentity | null;
}

async function buildSwitch(input: SwitchCase): Promise<{ access: RemoteAccessSwitch; opened: StandInController[]; steps: string[] }> {
  const opened: StandInController[] = [];
  const steps: string[] = [];
  const open = async (settings: RemoteSettings) => {
    if (input.isOpenFailing === true) throw new Error("listener build failed");
    const controller = new StandInController(settings);
    opened.push(controller);
    return controller;
  };
  const deps: AccessSwitchDeps = {
    boot: async (settings) => (settings.enabled ? open(settings) : null),
    runStep: async (act) => {
      steps.push(act);
      return input.step ?? "written";
    },
    readSettings: async () => {
      if (input.isReadFailing === true) throw new Error("monitor/.env unreadable");
      return input.written ?? ON;
    },
    open,
    isDeviceOff: async () => input.isDeviceOff ?? false,
    readIdentity: async () => (input.identity === undefined ? { ...HOME_NETWORK, interface: "en0" } : input.identity),
    readHostName: async () => "owner-mac.local",
    getAddress: () => "192.168.0.24",
    readCertificate: async () => null,
    log: pino({ level: "silent" }),
  };
  const access = new RemoteAccessSwitch(deps, input.booted ?? OFF);
  await access.boot();
  return { access, opened, steps };
}

describe("turning access on or trusting a network from the Mac page", () => {
  test("turning on runs the on step, then opens the listener in this process from the settings the step wrote", async () => {
    const { access, opened, steps } = await buildSwitch({ written: ON });
    const result = await access.turnOn();
    assert.deepEqual([result, steps, opened.map((controller) => controller.settings)], [{ outcome: "written", trustedCount: 1 }, ["on"], [ON]]);
    assert.deepEqual(access.getAccess(), { enabled: true, trusted: [HOME_NETWORK] });
  });

  test("trusting closes the open listener and opens one that knows the network the step added", async () => {
    const written = { ...ON, trusted: [HOME_NETWORK, OFFICE_NETWORK] };
    const { access, opened } = await buildSwitch({ booted: ON, written });
    const result = await access.trust();
    assert.deepEqual([result, opened.map((controller) => controller.isOpen), opened[1]?.settings], [{ outcome: "written", trustedCount: 2 }, [false, true], written]);
  });

  test("a step that wrote nothing leaves the listener and the settings as they were", async () => {
    const { access, opened, steps } = await buildSwitch({ booted: ON, step: "already_trusted", written: { ...ON, trusted: [] } });
    const result = await access.trust();
    assert.deepEqual([result, steps, opened.map((controller) => controller.isOpen)], [{ outcome: "already_trusted", trustedCount: null }, ["trust"], [true]]);
    assert.deepEqual(access.getAccess(), { enabled: true, trusted: [HOME_NETWORK] });
  });

  test("a device's off holds over a trust, so nothing reopens", async () => {
    const { access, opened } = await buildSwitch({ booted: ON, isDeviceOff: true });
    const result = await access.trust();
    assert.deepEqual([result.outcome, opened.filter((controller) => controller.isOpen).length, access.getAccess().enabled], ["written", 0, false]);
  });

  const failedStarts: { name: string; input: SwitchCase }[] = [
    { name: "the listener cannot be built", input: { isOpenFailing: true } },
    { name: "the written settings cannot be read", input: { isReadFailing: true } },
    { name: "the written settings are still off", input: { written: { ...ON, enabled: false } } },
  ];
  for (const row of failedStarts) {
    test(`when ${row.name}, the step's write stays for the next restart and this process is left closed and reports start_failed`, async () => {
      const { access, opened } = await buildSwitch({ ...row.input, booted: { ...OFF } });
      const result = await access.turnOn();
      assert.deepEqual([result, opened.filter((controller) => controller.isOpen).length, access.getAccess().enabled], [
        { outcome: "start_failed", trustedCount: null },
        0,
        false,
      ]);
    });
  }

  test("a start that fails after a trust also closes the listener that was open", async () => {
    const { access, opened } = await buildSwitch({ booted: ON, isReadFailing: true });
    const result = await access.trust();
    assert.deepEqual([result.outcome, opened.map((controller) => controller.isOpen)], ["start_failed", [false]]);
  });
});

describe("turning access off from the Mac page", () => {
  test("persists through the off step, then closing leaves the listener closed and the view off with the trusted list kept", async () => {
    const { access, opened, steps } = await buildSwitch({ booted: ON });
    const outcome = await access.setOff();
    await access.close();
    assert.deepEqual([outcome, steps, opened.map((controller) => controller.isTurnedOff), access.getAccess()], [
      "written",
      ["off"],
      [true],
      { enabled: false, trusted: [HOME_NETWORK] },
    ]);
  });
});

describe("the setup facts", () => {
  const rows: { name: string; identity: NetworkIdentity | null; expected: Record<string, unknown> }[] = [
    {
      name: "on the trusted network",
      identity: { ...HOME_NETWORK, interface: "en0" },
      expected: { hasRouter: true, isNetworkTrusted: true, listenReason: "trusted", isAnswering: true, address: "192.168.0.24" },
    },
    {
      name: "on another network",
      identity: { ...OFFICE_NETWORK, interface: "en0" },
      expected: { hasRouter: true, isNetworkTrusted: false, listenReason: "untrusted", isAnswering: true, address: "192.168.0.24" },
    },
    {
      name: "with no router read, so no interface address either",
      identity: null,
      expected: { hasRouter: false, isNetworkTrusted: false, listenReason: "identity_unreadable", isAnswering: true, address: null },
    },
  ];
  for (const row of rows) {
    test(`${row.name}, say whether the current network is trusted, how many are, and whether the Mac answers`, async () => {
      const { access } = await buildSwitch({ booted: ON, identity: row.identity });
      const facts = await access.getSetupFacts();
      assert.deepEqual(facts, {
        enabled: true,
        isOffByDevice: false,
        trustedCount: 1,
        hostName: "owner-mac.local",
        port: 16443,
        deviceLimit: 10,
        ...row.expected,
      });
    });
  }
});

describe("the shell's write step", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) deleteDirectory(dir);
  });

  /** A stand-in step that records its argv beside itself and exits with the given code after the given sleep. */
  async function writeStep(exitCode: number, sleepSeconds = 0): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "access-step-"));
    dirs.push(dir);
    const file = path.join(dir, "remote-access-set.sh");
    await writeFile(file, `printf '%s\\n' "$#" "$@" > "$(dirname "$0")/argv"\nsleep ${sleepSeconds}\nexit ${exitCode}\n`);
    return file;
  }

  const rows: { exitCode: number; outcome: AccessStepOutcome }[] = [
    { exitCode: 0, outcome: "written" },
    { exitCode: 6, outcome: "network_unreadable" },
    { exitCode: 7, outcome: "keys_not_created" },
    { exitCode: 8, outcome: "env_not_rendered" },
    { exitCode: 9, outcome: "already_trusted" },
    { exitCode: 2, outcome: "write_failed" },
    { exitCode: 1, outcome: "write_failed" },
  ];
  for (const row of rows) {
    test(`exit ${row.exitCode} reads as ${row.outcome}, the act passed as the one argument`, async () => {
      const file = await writeStep(row.exitCode);
      const outcome = await runAccessStep("trust", { file });
      const argv = await readFile(path.join(path.dirname(file), "argv"), "utf8");
      assert.deepEqual([outcome, argv], [row.outcome, "1\ntrust\n"]);
    });
  }

  test("a step that outlives its timeout is killed and reads as write_failed", async () => {
    const file = await writeStep(0, 5);
    const started = Date.now();
    const outcome = await runAccessStep("on", { file, timeoutMs: 300 });
    assert.deepEqual([outcome, Date.now() - started < 4_000], ["write_failed", true]);
  });
});
