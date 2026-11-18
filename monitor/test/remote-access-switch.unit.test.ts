// The Mac page's on, off and trust in this process: the shell step writes, the switch applies the settings it wrote.
// Runner: npx tsx --test test/remote-access-switch.unit.test.ts

import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import pino from "pino";

import type { AccessStepOutcome, SetupFacts } from "../src/server/remote/admin-routes.js";
import type { NetworkIdentity, NetworkLink } from "../src/server/remote/network.js";
import type { RemoteSettings } from "../src/server/remote/settings.js";
import { type AccessSwitchDeps, CONFIRM_TTL_MS, RemoteAccessSwitch, isDeviceOff, runAccessStep, setDeviceOff } from "../src/server/remote/start.js";
import { deleteDirectory } from "./lib/remove-dir.js";

// the write step's library → its exit-code constants
const SHELL_LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "lib", "ga-remote.sh");
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
  readonly link?: NetworkLink;
  /** runs after each step → a network that changes mid-act */
  readonly afterStep?: (act: string, network: StandInNetwork) => void;
  /** the real access-state marker in this directory instead of the stand-in */
  readonly dataDir?: string;
}

/** The network the Mac is on now, as the switch reads it, and the clock it reads. */
interface StandInNetwork {
  current: NetworkIdentity | null;
  clock: number;
  /** network reads so far → a shared read is counted once */
  reads: number;
}

interface BuiltSwitch {
  readonly access: RemoteAccessSwitch;
  readonly opened: StandInController[];
  readonly steps: string[];
  /** the network each trust step was handed */
  readonly handed: NetworkIdentity[];
  readonly network: StandInNetwork;
}

async function buildSwitch(input: SwitchCase): Promise<BuiltSwitch> {
  const opened: StandInController[] = [];
  const steps: string[] = [];
  const handed: NetworkIdentity[] = [];
  const network: StandInNetwork = { current: input.identity === undefined ? { ...HOME_NETWORK, interface: "en0" } : input.identity, clock: Date.parse("2026-11-17T09:00:00.000Z"), reads: 0 };
  const open = async (settings: RemoteSettings) => {
    if (input.isOpenFailing === true) throw new Error("listener build failed");
    const controller = new StandInController(settings);
    opened.push(controller);
    return controller;
  };
  const deps: AccessSwitchDeps = {
    boot: async (settings) => (settings.enabled ? open(settings) : null),
    runStep: async (step) => {
      steps.push(step.act);
      if (step.act === "trust") handed.push(step.shown);
      input.afterStep?.(step.act, network);
      return input.step ?? "written";
    },
    readSettings: async () => {
      if (input.isReadFailing === true) throw new Error("monitor/.env unreadable");
      return input.written ?? ON;
    },
    open,
    isDeviceOff: async () => (input.dataDir === undefined ? (input.isDeviceOff ?? false) : isDeviceOff(input.dataDir)),
    setDeviceOff: async () => {
      steps.push("device-off marker");
    },
    readIdentity: async () => {
      network.reads += 1;
      return network.current;
    },
    readLink: async () => input.link ?? "wifi",
    readHostName: async () => "owner-mac.local",
    getAddress: () => "192.168.0.24",
    readCertificate: async () => null,
    log: pino({ level: "silent" }),
    now: () => network.clock,
  };
  const access = new RemoteAccessSwitch(deps, input.booted ?? OFF);
  await access.boot();
  return { access, opened, steps, handed, network };
}

/** What the page reads of the feature after an act: on in config, the trusted count, the listener answering. */
async function getView(access: RemoteAccessSwitch): Promise<Pick<SetupFacts, "enabled" | "trustedCount" | "isAnswering">> {
  const facts = await access.getSetupFacts();
  return { enabled: facts.enabled, trustedCount: facts.trustedCount, isAnswering: facts.isAnswering };
}

/** The page's order: the confirm reads the network, then the person confirms the act. */
async function confirmThen<T>(access: RemoteAccessSwitch, act: () => Promise<T>): Promise<T> {
  await access.getConfirmFacts();
  return act();
}

describe("turning access on or trusting a network from the Mac page", () => {
  test("turning on runs the on step, then opens the listener in this process from the settings the step wrote, adding no trust on a trusted network", async () => {
    const { access, opened, steps } = await buildSwitch({ written: ON });
    const result = await confirmThen(access, () => access.turnOn());
    assert.deepEqual([result, steps, opened.map((controller) => controller.settings)], [{ outcome: "written", trustedCount: 1, trust: null }, ["on"], [ON]]);
    assert.deepEqual(await getView(access), { enabled: true, trustedCount: 1, isAnswering: true });
  });

  test("trusting closes the open listener and opens one that knows the network the step added", async () => {
    const written = { ...ON, trusted: [HOME_NETWORK, OFFICE_NETWORK] };
    const { access, opened } = await buildSwitch({ booted: ON, written, identity: { ...OFFICE_NETWORK, interface: "en0" } });
    const result = await confirmThen(access, () => access.trust());
    assert.deepEqual([result, opened.map((controller) => controller.isOpen), opened[1]?.settings], [{ outcome: "written", trustedCount: 2 }, [false, true], written]);
  });

  test("a step that wrote nothing leaves the listener and the settings as they were", async () => {
    const { access, opened, steps } = await buildSwitch({ booted: ON, step: "already_trusted", written: { ...ON, trusted: [] } });
    const result = await confirmThen(access, () => access.trust());
    assert.deepEqual([result, steps, opened.map((controller) => controller.isOpen)], [{ outcome: "already_trusted", trustedCount: null }, ["trust"], [true]]);
    assert.deepEqual(await getView(access), { enabled: true, trustedCount: 1, isAnswering: true });
  });

  test("a device's off holds over a trust, so nothing reopens", async () => {
    const { access, opened } = await buildSwitch({ booted: ON, isDeviceOff: true });
    const result = await confirmThen(access, () => access.trust());
    assert.deepEqual([result.outcome, opened.filter((controller) => controller.isOpen).length, (await getView(access)).isAnswering], ["written", 0, false]);
  });

  const failedStarts: { name: string; input: SwitchCase }[] = [
    { name: "the listener cannot be built", input: { isOpenFailing: true } },
    { name: "the written settings cannot be read", input: { isReadFailing: true } },
    { name: "the written settings are still off", input: { written: { ...ON, enabled: false } } },
  ];
  for (const row of failedStarts) {
    test(`when ${row.name}, the step's write stays for the next restart and this process is left closed and reports start_failed`, async () => {
      const { access, opened } = await buildSwitch({ ...row.input, booted: { ...OFF } });
      const result = await confirmThen(access, () => access.turnOn());
      assert.deepEqual([result, opened.filter((controller) => controller.isOpen).length, (await getView(access)).isAnswering], [
        { outcome: "start_failed", trustedCount: null, trust: null },
        0,
        false,
      ]);
    });
  }

  test("a start that fails after a trust also closes the listener that was open", async () => {
    const { access, opened } = await buildSwitch({ booted: ON, isReadFailing: true });
    const result = await confirmThen(access, () => access.trust());
    assert.deepEqual([result.outcome, opened.map((controller) => controller.isOpen)], ["start_failed", [false]]);
  });
});

describe("the network the confirm showed", () => {
  const confirmRows: { name: string; identity: NetworkIdentity | null; link: NetworkLink; expected: Record<string, unknown> }[] = [
    { name: "a trusted network over Wi-Fi", identity: { ...HOME_NETWORK, interface: "en0" }, link: "wifi", expected: { router: "192.168.0.1", link: "wifi", isNetworkTrusted: true } },
    { name: "another network over a wire", identity: { ...OFFICE_NETWORK, interface: "en5" }, link: "wired", expected: { router: "10.20.0.1", link: "wired", isNetworkTrusted: false } },
    { name: "no router read", identity: null, link: "wifi", expected: { router: null, link: "unknown", isNetworkTrusted: false } },
  ];
  for (const row of confirmRows) {
    test(`the confirm read on ${row.name} names the router, the link and whether the network is trusted`, async () => {
      const { access } = await buildSwitch({ booted: ON, identity: row.identity, link: row.link });
      assert.deepEqual(await access.getConfirmFacts(), row.expected);
    });
  }

  const OTHER_ROUTER = { ...HOME_NETWORK, gateway: "192.168.0.254", interface: "en0" };
  const refusals: { name: string; arrange: (built: BuiltSwitch) => Promise<void>; expected: string }[] = [
    { name: "no confirm read came first", arrange: async () => undefined, expected: "confirm_stale" },
    {
      name: "the read is past its expiry",
      arrange: async ({ access, network }) => {
        await access.getConfirmFacts();
        network.clock += CONFIRM_TTL_MS + 1;
      },
      expected: "confirm_stale",
    },
    {
      name: "the read found no router",
      arrange: async ({ access, network }) => {
        network.current = null;
        await access.getConfirmFacts();
        network.current = { ...HOME_NETWORK, interface: "en0" };
      },
      expected: "confirm_stale",
    },
    {
      name: "the read already served an act",
      arrange: async ({ access }) => {
        await access.getConfirmFacts();
        await access.trust();
      },
      expected: "confirm_stale",
    },
    ...[
      { name: "another router address", current: OTHER_ROUTER },
      { name: "another router hardware address", current: { ...HOME_NETWORK, hardwareAddress: "a4:2b:b0:11:22:44", interface: "en0" } },
      { name: "another link to the same router", current: { ...HOME_NETWORK, interface: "en5" } },
      { name: "no network readable", current: null },
    ].map((change) => ({
      name: `the network at the act has ${change.name}`,
      arrange: async ({ access, network }: BuiltSwitch) => {
        await access.getConfirmFacts();
        network.current = change.current;
      },
      expected: "network_changed",
    })),
  ];
  for (const act of ["turnOn", "trust"] as const) {
    for (const row of refusals) {
      test(`${act} refuses with ${row.expected} and runs no step when ${row.name}`, async () => {
        const built = await buildSwitch({ booted: OFF, written: ON });
        await row.arrange(built);
        built.steps.length = 0;
        const result = await built.access[act]();
        assert.deepEqual([result.outcome, result.trustedCount, built.steps], [row.expected, null, []]);
      });
    }

    test(`${act} runs its step when the network is the one shown, read just inside its expiry`, async () => {
      const { access, network, steps } = await buildSwitch({ booted: OFF, written: ON, identity: { ...OFFICE_NETWORK, interface: "en0" } });
      await access.getConfirmFacts();
      network.clock += CONFIRM_TTL_MS;
      const result = await access[act]();
      assert.deepEqual([result.outcome, steps[0]], ["written", act === "turnOn" ? "on" : "trust"]);
    });
  }

  for (const act of ["turnOn", "trust"] as const) {
    test(`${act} hands the trust step the network the confirm showed, for the step to match against its own read`, async () => {
      const shown = { ...OFFICE_NETWORK, interface: "en0" };
      const { access, handed } = await buildSwitch({ booted: OFF, written: ON, identity: shown });
      await confirmThen(access, () => access[act]());
      assert.deepEqual(handed, [shown]);
    });
  }

  test("turning on a network not yet trusted trusts the network shown, in the same act after the on", async () => {
    const { access, steps } = await buildSwitch({ booted: OFF, written: ON, identity: { ...OFFICE_NETWORK, interface: "en0" } });
    const result = await confirmThen(access, () => access.turnOn());
    assert.deepEqual([result, steps], [{ outcome: "written", trustedCount: 1, trust: { outcome: "written", trustedCount: 1 } }, ["on", "trust"]]);
  });

  test("a network that changes after the on step is not trusted, and the on stays", async () => {
    const afterStep = (act: string, network: StandInNetwork) => {
      if (act === "on") network.current = { ...OTHER_ROUTER };
    };
    const { access, steps } = await buildSwitch({ booted: OFF, written: ON, identity: { ...OFFICE_NETWORK, interface: "en0" }, afterStep });
    const result = await confirmThen(access, () => access.turnOn());
    assert.deepEqual([result, steps], [{ outcome: "written", trustedCount: 1, trust: { outcome: "network_changed", trustedCount: null } }, ["on"]]);
  });
});

describe("turning access off from the Mac page", () => {
  test("persists through the off step, then closing leaves the listener closed and the view off with the trusted list kept", async () => {
    const { access, opened, steps } = await buildSwitch({ booted: ON });
    const outcome = await access.setOff();
    await access.close();
    assert.deepEqual([outcome, steps, opened.map((controller) => controller.isTurnedOff), await getView(access)], [
      "written",
      ["off"],
      [true],
      { enabled: false, trustedCount: 1, isAnswering: false },
    ]);
  });

  test("an off step that did not write leaves the device-off marker instead, so a restart does not reopen", async () => {
    const { access, steps } = await buildSwitch({ booted: ON, step: "write_failed" });
    assert.deepEqual([await access.setOff(), steps], ["write_failed", ["off", "device-off marker"]]);
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

  test("after a registered device turns access off, the facts report access off by the device while config still says on", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "access-state-"));
    try {
      const { access, opened } = await buildSwitch({ booted: ON, dataDir });
      // the device's off: the open listener turned off, the marker written (start.ts → openRemoteAccess)
      await opened[0]?.turnOff();
      await setDeviceOff(dataDir);
      const { enabled, isOffByDevice, listenReason, isAnswering } = await access.getSetupFacts();
      assert.deepEqual({ enabled, isOffByDevice, listenReason, isAnswering }, { enabled: false, isOffByDevice: true, listenReason: "disabled", isAnswering: false });
    } finally {
      deleteDirectory(dataDir);
    }
  });
});

test("setup reads that overlap share one network read, and a read after them reads again", async () => {
  const { access, network } = await buildSwitch({ booted: ON });
  const [first, second] = await Promise.all([access.getSetupFacts(), access.getSetupFacts()]);
  const readsWhileShared = network.reads;
  await access.getSetupFacts();
  assert.deepEqual([first, readsWhileShared, network.reads], [second, 1, 2]);
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

  /** The value a shell constant holds once the write step's library is sourced; "" when it is not set. */
  async function getShellCode(name: string): Promise<string> {
    const { stdout } = await promisify(execFile)("/bin/bash", ["-c", 'source "$1" && printf "%s" "${!2-}"', "_", SHELL_LIB, name]);
    return stdout;
  }

  // a named code is read from the shell → renumbering it there, or the monitor's map, turns its row red
  const rows: { exit: number | string; outcome: AccessStepOutcome }[] = [
    { exit: 0, outcome: "written" },
    { exit: "GA_REMOTE_NETWORK_UNREADABLE", outcome: "network_unreadable" },
    { exit: "GA_REMOTE_KEYS_NOT_CREATED", outcome: "keys_not_created" },
    { exit: "GA_REMOTE_ENV_NOT_RENDERED", outcome: "env_not_rendered" },
    { exit: "GA_REMOTE_ALREADY_TRUSTED", outcome: "already_trusted" },
    { exit: "GA_REMOTE_NETWORK_NOT_SHOWN", outcome: "network_changed" },
    { exit: "GA_REMOTE_CONFIG_MALFORMED", outcome: "config_malformed" },
    { exit: 2, outcome: "write_failed" },
    { exit: 1, outcome: "write_failed" },
  ];
  for (const row of rows) {
    test(`exit ${row.exit} reads as ${row.outcome}`, async () => {
      const code = typeof row.exit === "number" ? String(row.exit) : await getShellCode(row.exit);
      assert.match(code, /^[0-9]+$/, `${row.exit} is set by the shell`);
      const file = await writeStep(Number(code));
      assert.equal(await runAccessStep({ act: "off" }, { file }), row.outcome);
    });
  }

  test("on and off pass the act alone; trust passes the network shown as interface, gateway and hardware address", async () => {
    const rows = [
      { name: "on", step: { act: "on" } as const, argv: "1\non\n" },
      { name: "off", step: { act: "off" } as const, argv: "1\noff\n" },
      {
        name: "trust",
        step: { act: "trust", shown: { ...HOME_NETWORK, interface: "en1" } } as const,
        argv: "4\ntrust\nen1\n192.168.0.1\na4:2b:b0:11:22:33\n",
      },
    ];
    for (const row of rows) {
      const file = await writeStep(0);
      await runAccessStep(row.step, { file });
      assert.equal(await readFile(path.join(path.dirname(file), "argv"), "utf8"), row.argv, row.name);
    }
  });

  test("a step that outlives its timeout is killed and reads as write_failed", async () => {
    const file = await writeStep(0, 5);
    const started = Date.now();
    const outcome = await runAccessStep({ act: "on" }, { file, timeoutMs: 300 });
    assert.deepEqual([outcome, Date.now() - started < 4_000], ["write_failed", true]);
  });
});
