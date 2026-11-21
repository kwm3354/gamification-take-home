import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Starts a throwaway single-replica TigerBeetle from the binary in TB_BIN.
 * With TB_ADDRESS set it uses a server that is already running (for example the one from
 * docker-compose.yml) and starts nothing.
 * Returns undefined when neither is set, so tests that need it can skip.
 */
export async function startTigerBeetle(): Promise<{ address: string; stop: () => void } | undefined> {
  if (process.env.TB_ADDRESS) return { address: process.env.TB_ADDRESS, stop: () => {} };
  const bin = process.env.TB_BIN;
  if (!bin) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "tb-"));
  const file = join(dir, "0_0.tigerbeetle");
  execFileSync(bin, ["format", "--cluster=0", "--replica=0", "--replica-count=1", "--development", file], {
    stdio: "ignore",
  });
  const port = await freePort();
  const server: ChildProcess = spawn(bin, ["start", `--addresses=${port}`, "--development", file], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TigerBeetle did not start in 20 s")), 20_000);
    server.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => reject(new Error(`TigerBeetle exited with ${code}`)));
  });
  return {
    address: `127.0.0.1:${port}`,
    stop: () => {
      server.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === "object" ? resolve(address.port) : reject()));
    });
  });
}
