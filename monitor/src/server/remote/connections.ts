// Open sockets per registered device on the remote listener → a cut-off ends that device's connections at once,
// not at its next request on a kept-alive socket.

import type { Socket } from "node:net";

export class DeviceConnections {
  readonly #sockets = new Map<string, Set<Socket>>();

  /** Called by the gate on every admitted request; a socket already tracked is a no-op. */
  track(deviceId: bigint, socket: Socket): void {
    const key = String(deviceId);
    const sockets = this.#sockets.get(key) ?? new Set<Socket>();
    if (sockets.has(socket)) return;
    sockets.add(socket);
    this.#sockets.set(key, sockets);
    socket.once("close", () => this.#forget(key, socket));
  }

  /** @returns how many open sockets were destroyed */
  close(deviceId: bigint): number {
    const key = String(deviceId);
    const sockets = this.#sockets.get(key);
    this.#sockets.delete(key);
    for (const socket of sockets ?? []) socket.destroy();
    return sockets?.size ?? 0;
  }

  #forget(key: string, socket: Socket): void {
    const sockets = this.#sockets.get(key);
    sockets?.delete(socket);
    if (sockets?.size === 0) this.#sockets.delete(key);
  }
}
