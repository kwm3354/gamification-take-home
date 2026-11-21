import { type DemoTenant, demoTenants } from "../tenants/demo-tenants.ts";
import type { Faults } from "./faults.ts";
import { hmacBase64 } from "./signing.ts";
import { type CallbackRecord, type Reply, type World, isoNow, toMinor } from "./state.ts";

export interface BGrantInput {
  customerId: string;
  valueMinor: number;
  currency: string;
  externalRef: string;
}

export function parseBGrant(body: Record<string, unknown>): BGrantInput | string {
  const { customerId, reward, externalRef } = body;
  if (typeof customerId !== "string" || !customerId) return "customerId is required";
  if (typeof externalRef !== "string" || !externalRef) return "externalRef is required";
  if (typeof reward !== "object" || reward === null) return "reward is required";
  const { value, currency } = reward as Record<string, unknown>;
  const valueMinor = typeof value === "string" ? toMinor(value) : null;
  if (valueMinor === null || valueMinor <= 0) return "reward.value must be a decimal string";
  if (typeof currency !== "string" || !currency) return "reward.currency is required";
  return { customerId, valueMinor, currency, externalRef };
}

/** Always makes a new request, even for an externalRef seen before. This is the trap. */
export function bGrant(world: World, tenant: DemoTenant, input: BGrantInput, refuse: boolean): Reply {
  const requestId = world.nextRequestId();
  const plannedState = refuse ? "DECLINED" : "GRANTED";
  world.bRequests.push({
    tenantId: tenant.id,
    requestId,
    externalRef: input.externalRef,
    customerId: input.customerId,
    valueMinor: input.valueMinor,
    currency: input.currency,
    state: "ACCEPTED",
    plannedState,
    reason: refuse ? "player_blocked" : undefined,
  });
  world.callbacks.push({
    tenantId: tenant.id,
    requestId,
    externalRef: input.externalRef,
    finalState: plannedState,
    status: "queued",
    sentCount: 0,
  });
  return { status: 202, body: { requestId, state: "ACCEPTED" } };
}

export function bFind(world: World, tenant: DemoTenant, externalRef: string): Reply {
  const items = world.bRequests
    .filter((r) => r.tenantId === tenant.id && r.externalRef === externalRef)
    .map((r) => ({
      requestId: r.requestId,
      state: r.state,
      ...(r.state === "DECLINED" ? { reason: r.reason } : {}),
    }));
  return { status: 200, body: { items } };
}

export interface Delivered {
  tenantId: string;
  requestId: string;
  state: "GRANTED" | "DECLINED";
  outcome: "lost" | "sent";
  answers: { status: number; body: unknown }[];
}

async function post(url: string, raw: string, headers: Record<string, string>) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: raw,
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: keep the text
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: String(err) };
  }
}

/** Delivers every queued callback now. A `delay` fault leaves one queued for the next call. */
export async function deliverAll(world: World, faults: Faults, appUrl: string): Promise<Delivered[]> {
  const out: Delivered[] = [];
  const queued: CallbackRecord[] = world.callbacks.filter((c) => c.status === "queued");
  // Mark them at once so a second deliver call does not take the same ones.
  for (const cb of queued) cb.status = "delivering";
  for (const cb of queued) {
    const applied = faults.take("b.callback", cb.tenantId);
    if (applied?.fault === "delay") {
      cb.status = "queued";
      continue;
    }
    const request = world.bRequests.find((r) => r.requestId === cb.requestId && r.tenantId === cb.tenantId);
    const tenant = demoTenants.find((t) => t.id === cb.tenantId);
    if (!request || !tenant) continue;
    request.state = request.plannedState;
    if (request.state === "GRANTED") {
      world.grants.push({
        tenantId: tenant.id,
        platform: "B",
        playerId: request.customerId,
        reference: request.externalRef,
        amountMinor: request.valueMinor,
        currency: request.currency,
        platformRef: request.requestId,
        at: isoNow(),
      });
    }
    if (applied?.fault === "lost") {
      cb.status = "lost";
      out.push({
        tenantId: tenant.id,
        requestId: cb.requestId,
        state: request.state,
        outcome: "lost",
        answers: [],
      });
      continue;
    }
    const raw = JSON.stringify({
      requestId: request.requestId,
      externalRef: request.externalRef,
      state: request.state,
      ...(request.reason ? { reason: request.reason } : {}),
    });
    const headers = { "X-Beta-Auth": hmacBase64(tenant.webhookSecret, raw) };
    const times = applied?.fault === "twice" ? 2 : 1;
    const answers: { status: number; body: unknown }[] = [];
    for (let i = 0; i < times; i++) {
      answers.push(await post(`${appUrl}/webhooks/${tenant.id}/rewards`, raw, headers));
      cb.sentCount += 1;
    }
    cb.status = "delivered";
    out.push({
      tenantId: tenant.id,
      requestId: cb.requestId,
      state: request.state,
      outcome: "sent",
      answers,
    });
  }
  return out;
}
