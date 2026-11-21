import { randomUUID } from "node:crypto";
import { Injectable, type NestMiddleware } from "@nestjs/common";
import { withRequestId } from "./log.ts";

const VALID = /^[A-Za-z0-9._-]{1,64}$/;

interface Req {
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  setHeader(name: string, value: string): unknown;
}

/** Takes a valid `x-request-id` or makes a uuid, echoes it, and keeps it for every line of the request. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Req, res: Res, next: () => void): void {
    const given = req.headers["x-request-id"];
    const requestId = typeof given === "string" && VALID.test(given) ? given : randomUUID();
    res.setHeader("x-request-id", requestId);
    withRequestId(requestId, next);
  }
}
