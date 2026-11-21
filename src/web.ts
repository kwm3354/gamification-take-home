import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { demoAdmins } from "./tenants/demo-tenants.ts";

type Next = (err?: unknown) => void;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Where the built web app is in the image (`dist/web`), or null when it was not built. */
export function defaultWebDir(): string | null {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "web");
  return existsSync(join(dir, "index.html")) ? dir : null;
}

function send(res: ServerResponse, status: number, type: string, body: Buffer | string, cache: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": cache });
  res.end(body);
}

/**
 * Serves the web app at `/app/` and `GET /app-config.json`. Everything else goes on to the API.
 * `dir` is the folder with the build; null means "not built": only `/app-config.json` is served.
 * Call this before the app starts listening.
 */
export function mountWeb(
  app: INestApplication,
  options: { dir: string | null; fakeCasinoUrl: string; demoAdmins?: boolean },
): void {
  const root = options.dir === null ? null : normalize(options.dir);

  const handler = async (req: IncomingMessage, res: ServerResponse, next: Next): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname);
    } catch {
      return next();
    }

    if (pathname === "/app-config.json") {
      return send(
        res,
        200,
        TYPES[".json"]!,
        JSON.stringify({
          fakeCasinoUrl: options.fakeCasinoUrl,
          // This exposes the demo passwords on purpose, and only in demo mode (the seed is on).
          // The sign-in page offers these accounts. The field is left out when the seed is off.
          ...(options.demoAdmins
            ? {
                demoAdmins: demoAdmins.map((a) => ({
                  email: a.email,
                  password: a.password,
                  role: a.role,
                  tenantId: a.tenantId,
                })),
              }
            : {}),
        }),
        "no-store",
      );
    }
    if (root === null) return next();
    if (pathname === "/app") {
      res.writeHead(302, { location: "/app/" });
      res.end();
      return;
    }
    if (!pathname.startsWith("/app/")) return next();

    const relative = pathname.slice("/app/".length);
    const file = normalize(join(root, relative));
    const inside = file === root || file.startsWith(root + sep);
    const isFile = inside && relative !== "" && existsSync(file) && statSync(file).isFile();
    try {
      if (isFile) {
        const immutable = relative.startsWith("assets/");
        return send(
          res,
          200,
          TYPES[extname(file)] ?? "application/octet-stream",
          await readFile(file),
          immutable ? "public, max-age=31536000, immutable" : "no-cache",
        );
      }
      // A path with a file extension that does not exist is a missing file. Any other path is a page.
      if (extname(relative) !== "") return send(res, 404, TYPES[".txt"]!, "not found", "no-store");
      return send(res, 200, TYPES[".html"]!, await readFile(join(root, "index.html")), "no-cache");
    } catch (err) {
      next(err);
    }
  };

  (app.getHttpAdapter().getInstance() as { use: (fn: typeof handler) => void }).use(handler);
}
