import type {
  CasinoTenant,
  LogEntry,
  Me,
  Player,
  RedemptionData,
  Segment,
  StoreItem,
  Tracked,
} from "./types.ts";

export const LOG_LIMIT = 300;

export type Boot = "loading" | "ready" | "error";

export interface State {
  boot: Boot;
  fakeCasinoUrl: string;
  tenants: CasinoTenant[];
  tenantId: string;
  players: Player[];
  currentKey: string | null;
  adminName: string;
  adminKeys: Record<string, string>;
  /** Newest first. */
  tracked: Tracked[];
  meByPlayer: Record<string, Me>;
  wheelByTenant: Record<string, Segment[]>;
  itemsByTenant: Record<string, StoreItem[]>;
  /** Newest first, at most LOG_LIMIT. */
  log: LogEntry[];
}

/** The small part that is kept in localStorage and shared between tabs. */
export interface Persisted {
  tenantId: string;
  players: Player[];
  currentKey: string | null;
  adminName: string;
  redemptions: { id: string; playerKey: string; tenantId: string; itemName: string; createdAt: number }[];
}

export type Action =
  | { type: "config"; fakeCasinoUrl: string; tenants: CasinoTenant[] }
  | { type: "configFailed"; fakeCasinoUrl: string }
  | { type: "hydrate"; persisted: Persisted }
  | { type: "switchTenant"; tenantId: string }
  | { type: "addPlayer"; player: Player }
  | { type: "selectPlayer"; key: string }
  | { type: "token"; key: string; token: string; expiresAt: number }
  | { type: "me"; key: string; me: Me }
  | { type: "wheel"; tenantId: string; segments: Segment[] }
  | { type: "items"; tenantId: string; items: StoreItem[] }
  | { type: "track"; tracked: Omit<Tracked, "data">; data: RedemptionData | null }
  | { type: "redemption"; data: RedemptionData }
  | { type: "adminKey"; tenantId: string; key: string }
  | { type: "adminName"; name: string }
  | { type: "log"; entry: LogEntry };

export const initialState: State = {
  boot: "loading",
  fakeCasinoUrl: "",
  tenants: [],
  tenantId: "",
  players: [],
  currentKey: null,
  adminName: "playground",
  adminKeys: {},
  tracked: [],
  meByPlayer: {},
  wheelByTenant: {},
  itemsByTenant: {},
  log: [],
};

function lastPlayerOf(players: Player[], tenantId: string): string | null {
  const mine = players.filter((p) => p.tenantId === tenantId);
  return mine.length > 0 ? mine[mine.length - 1]!.key : null;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "config": {
      const adminKeys = { ...state.adminKeys };
      for (const t of action.tenants) adminKeys[t.id] ??= t.adminKey;
      const known = action.tenants.some((t) => t.id === state.tenantId);
      const tenantId = known ? state.tenantId : (action.tenants[0]?.id ?? "");
      const currentKey = known && state.currentKey ? state.currentKey : lastPlayerOf(state.players, tenantId);
      return {
        ...state,
        boot: "ready",
        fakeCasinoUrl: action.fakeCasinoUrl,
        tenants: action.tenants,
        adminKeys,
        tenantId,
        currentKey,
      };
    }
    case "configFailed":
      return { ...state, boot: "error", fakeCasinoUrl: action.fakeCasinoUrl };
    case "hydrate": {
      const p = action.persisted;
      const data = new Map(state.tracked.map((t) => [t.id, t.data]));
      return {
        ...state,
        tenantId: p.tenantId || state.tenantId,
        players: p.players,
        currentKey: p.currentKey,
        adminName: p.adminName,
        tracked: p.redemptions.map((r) => ({ ...r, data: data.get(r.id) ?? null })),
      };
    }
    case "switchTenant":
      return {
        ...state,
        tenantId: action.tenantId,
        currentKey: lastPlayerOf(state.players, action.tenantId),
      };
    case "addPlayer":
      return {
        ...state,
        players: [...state.players.filter((p) => p.key !== action.player.key), action.player],
        currentKey: action.player.key,
        tenantId: action.player.tenantId,
      };
    case "selectPlayer":
      return { ...state, currentKey: action.key };
    case "token":
      return {
        ...state,
        players: state.players.map((p) =>
          p.key === action.key ? { ...p, token: action.token, expiresAt: action.expiresAt } : p,
        ),
      };
    case "me":
      return { ...state, meByPlayer: { ...state.meByPlayer, [action.key]: action.me } };
    case "wheel":
      return { ...state, wheelByTenant: { ...state.wheelByTenant, [action.tenantId]: action.segments } };
    case "items":
      return { ...state, itemsByTenant: { ...state.itemsByTenant, [action.tenantId]: action.items } };
    case "track":
      if (state.tracked.some((t) => t.id === action.tracked.id)) return state;
      return { ...state, tracked: [{ ...action.tracked, data: action.data }, ...state.tracked] };
    case "redemption":
      return {
        ...state,
        tracked: state.tracked.map((t) => (t.id === action.data.id ? { ...t, data: action.data } : t)),
      };
    case "adminKey":
      return { ...state, adminKeys: { ...state.adminKeys, [action.tenantId]: action.key } };
    case "adminName":
      return { ...state, adminName: action.name };
    case "log":
      return { ...state, log: [action.entry, ...state.log].slice(0, LOG_LIMIT) };
  }
}

export function persistedOf(state: State): Persisted {
  return {
    tenantId: state.tenantId,
    players: state.players,
    currentKey: state.currentKey,
    adminName: state.adminName,
    redemptions: state.tracked.map(({ id, playerKey, tenantId, itemName, createdAt }) => ({
      id,
      playerKey,
      tenantId,
      itemName,
      createdAt,
    })),
  };
}

export function currentPlayer(state: State): Player | null {
  return state.players.find((p) => p.key === state.currentKey) ?? null;
}

export function isFinal(t: Tracked): boolean {
  const s = t.data?.status;
  return s === "issued" || s === "refused" || s === "insufficient";
}
