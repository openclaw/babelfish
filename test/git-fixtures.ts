import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { expect, onTestFinished, vi } from "vitest";

const exec = promisify(execFile);

export async function commitFixture(source: string): Promise<void> {
  await exec("git", ["-C", source, "init", "-q"]);
  await exec("git", ["-C", source, "add", "."]);
  await exec("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
}

export async function stalledGitRemote() {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", (error: NodeJS.ErrnoException) => expect(error.code).toBe("ECONNRESET"));
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/stalled.git`,
    async expectDisconnected() {
      expect(sockets.length).toBeGreaterThan(0);
      await vi.waitFor(() => expect(sockets.every((socket) => socket.destroyed)).toBe(true));
    },
  };
}
