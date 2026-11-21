import {
  type ClientDeps,
  type PlayerSession,
  type Result,
  describeFailure,
  fetchToken,
  playerRequest,
  request,
} from "./api.ts";
import { currentPlayer, isFinal } from "./state.ts";
import { dispatch, getState } from "./store.ts";
import type { CasinoTenant, Me, Player, RedemptionData, Segment, StoreItem } from "./types.ts";

let logId = 0;

const deps: ClientDeps = {
  fetch: (input, init) => window.fetch(input, init),
  record: (entry) => dispatch({ type: "log", entry: { ...entry, id: ++logId } }),
  now: () => Date.now(),
};

const appBase = (): string => window.location.origin;

export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function sessionFor(player: Player): PlayerSession {
  return {
    fakeCasinoUrl: getState().fakeCasinoUrl,
    player,
    onToken: (token, expiresAt) => dispatch({ type: "token", key: player.key, token, expiresAt }),
  };
}

function asPlayer(
  player: Player,
  method: string,
  path: string,
  body?: unknown,
  tag?: string,
): Promise<Result> {
  return playerRequest(deps, sessionFor(player), {
    method,
    url: `${appBase()}${path}`,
    ...(body === undefined ? {} : { body }),
    ...(tag ? { tag } : {}),
  });
}

/** Loads the casino list and the saved session, then makes sure the current casino has a player. */
export async function boot(): Promise<void> {
  let fakeCasinoUrl = "http://localhost:30081";
  try {
    const res = await window.fetch(`${appBase()}/app-config.json`);
    const body = (await res.json()) as { fakeCasinoUrl?: unknown };
    if (typeof body.fakeCasinoUrl === "string") fakeCasinoUrl = body.fakeCasinoUrl.replace(/\/$/, "");
  } catch {
    // keep the default
  }
  const res = await request(deps, {
    actor: "page -> casino",
    method: "GET",
    url: `${fakeCasinoUrl}/control/config`,
  });
  const tenants = (res.body as { tenants?: CasinoTenant[] } | null)?.tenants;
  if (!res.ok || !Array.isArray(tenants) || tenants.length === 0) {
    dispatch({ type: "configFailed", fakeCasinoUrl });
    return;
  }
  dispatch({ type: "config", fakeCasinoUrl, tenants });
  await loadGame();
}

/** Makes sure there is a current player for the chosen casino, then reads the game state. */
export async function loadGame(): Promise<void> {
  const s = getState();
  if (s.boot !== "ready" || !s.tenantId) return;
  if (!currentPlayer(s)) {
    const made = await newPlayer();
    if (!made) return;
  }
  await Promise.all([refreshMe(), loadWheel(), loadItems()]);
}

export async function newPlayer(): Promise<Player | null> {
  const s = getState();
  const externalId = `p-${uuid().replaceAll("-", "").slice(0, 6)}`;
  const fresh = await fetchToken(deps, s.fakeCasinoUrl, s.tenantId, externalId);
  if (!fresh) return null;
  const player: Player = {
    key: `${s.tenantId}:${externalId}`,
    tenantId: s.tenantId,
    externalId,
    token: fresh.token,
    expiresAt: fresh.expiresAt,
  };
  dispatch({ type: "addPlayer", player });
  return player;
}

export async function switchTenant(tenantId: string): Promise<void> {
  dispatch({ type: "switchTenant", tenantId });
  await loadGame();
}

export async function selectPlayer(key: string): Promise<void> {
  dispatch({ type: "selectPlayer", key });
  await refreshMe();
}

export async function createPlayerAndLoad(): Promise<void> {
  if (await newPlayer()) await refreshMe();
}

export async function refreshMe(
  tag?: string,
  player: Player | null = currentPlayer(getState()),
): Promise<Me | null> {
  if (!player) return null;
  const res = await asPlayer(player, "GET", "/me", undefined, tag);
  if (!res.ok) return null;
  const me = res.body as Me;
  dispatch({ type: "me", key: player.key, me });
  return me;
}

async function loadWheel(): Promise<void> {
  const s = getState();
  const player = currentPlayer(s);
  if (!player) return;
  const res = await asPlayer(player, "GET", "/wheel");
  const segments = (res.body as { segments?: Segment[] } | null)?.segments;
  if (res.ok && segments) dispatch({ type: "wheel", tenantId: player.tenantId, segments });
}

async function loadItems(): Promise<void> {
  const player = currentPlayer(getState());
  if (!player) return;
  const res = await asPlayer(player, "GET", "/store/items");
  if (res.ok && Array.isArray(res.body))
    dispatch({ type: "items", tenantId: player.tenantId, items: res.body as StoreItem[] });
}

export interface Outcome {
  ok: boolean;
  message: string;
}

/** The casino tells us about a 20.00 deposit; we then read the player again. */
export async function deposit(): Promise<Outcome> {
  let player = currentPlayer(getState());
  if (!player) player = await newPlayer();
  if (!player) return { ok: false, message: "The casino did not answer. Try again." };
  const res = await request(deps, {
    actor: "casino -> us",
    method: "POST",
    url: `${getState().fakeCasinoUrl}/control/deposit`,
    body: { tenantId: player.tenantId, playerId: player.externalId, amount: "20.00" },
  });
  const sent = (res.body as { sent?: { status: number }[] } | null)?.sent?.[0];
  if (!res.ok || !sent || sent.status !== 200) {
    return { ok: false, message: "The deposit did not go through. Try again." };
  }
  await refreshMe("after-deposit", player);
  return { ok: true, message: "" };
}

export interface SpinResult extends Outcome {
  segmentIndex: number;
  coins: number;
}

/** Asks the server to spin the oldest available spin. The client sends nothing else. */
export async function spin(): Promise<SpinResult> {
  const player = currentPlayer(getState());
  const me = player ? getState().meByPlayer[player.key] : undefined;
  const available = me?.spins.find((x) => x.status === "available");
  const fail = (message: string): SpinResult => ({ ok: false, message, segmentIndex: -1, coins: 0 });
  if (!player || !available) return fail("There is no spin to use.");
  const res = await asPlayer(player, "POST", `/wheel/spins/${available.id}/spin`, undefined, "spin");
  const body = res.body as { segmentIndex?: number; coins?: number } | null;
  if (!res.ok || typeof body?.segmentIndex !== "number") {
    return fail(
      `${res.status === 0 ? "No answer from the game." : describeFailure(res)} The wheel did not move and your spin is still yours.`,
    );
  }
  return { ok: true, message: "", segmentIndex: body.segmentIndex, coins: Number(body.coins ?? 0) };
}

export async function redeem(item: StoreItem, itemName: string): Promise<Outcome> {
  const player = currentPlayer(getState());
  if (!player) return { ok: false, message: "No player yet." };
  // A fresh Idempotency-Key for every click.
  const res = await playerRequest(deps, sessionFor(player), {
    method: "POST",
    url: `${appBase()}/store/redemptions`,
    headers: { "Idempotency-Key": uuid() },
    body: { itemId: item.id },
    tag: "redeem",
  });
  const data = res.body as RedemptionData | null;
  if (!res.ok || !data?.id) {
    return { ok: false, message: `${describeFailure(res)} Nothing was taken from your coins.` };
  }
  dispatch({
    type: "track",
    tracked: {
      id: data.id,
      playerKey: player.key,
      tenantId: player.tenantId,
      itemName,
      createdAt: Date.now(),
    },
    data,
  });
  await refreshMe(undefined, player);
  return { ok: true, message: "" };
}

/** Reads every redemption that is not final, and the current player's balance. */
export async function pollOnce(): Promise<void> {
  const s = getState();
  const pending = s.tracked.filter((t) => !isFinal(t));
  if (pending.length === 0) return;
  await Promise.all(pending.map((t) => readRedemption(t.id, t.playerKey)));
  await refreshMe();
}

async function readRedemption(id: string, playerKey: string): Promise<void> {
  const player = getState().players.find((p) => p.key === playerKey);
  if (!player) return;
  const res = await asPlayer(player, "GET", `/store/redemptions/${id}`);
  if (res.ok) dispatch({ type: "redemption", data: res.body as RedemptionData });
}

/** Reads the balance and the redemptions of every player of this session (for the admin page). */
export async function refreshSession(): Promise<void> {
  const s = getState();
  await Promise.all(s.players.map((p) => refreshMe(undefined, p)));
  await Promise.all(s.tracked.map((t) => readRedemption(t.id, t.playerKey)));
}

/** A call to our admin API for one casino. */
export function adminRequest(
  tenantId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Result> {
  const s = getState();
  return request(deps, {
    actor: "admin -> us",
    method,
    url: `${appBase()}/admin/${encodeURIComponent(tenantId)}${path}`,
    headers: { "X-Admin-Key": s.adminKeys[tenantId] ?? "", "X-Admin-Name": s.adminName },
    ...(body === undefined ? {} : { body }),
  });
}
