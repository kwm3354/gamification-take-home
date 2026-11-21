import { useRef, useState } from "react";
import { boot, deposit, redeem, refreshMe, spin } from "../actions.ts";
import { BehindScenes } from "../components/BehindScenes.tsx";
import { CoinBurst } from "../components/CoinBurst.tsx";
import { CountUp } from "../components/CountUp.tsx";
import { DemoControls } from "../components/DemoControls.tsx";
import { Rewards } from "../components/Rewards.tsx";
import { Wheel, type WheelHandle } from "../components/Wheel.tsx";
import { coins, rewardTitle } from "../format.ts";
import { nextAction } from "../next-action.ts";
import { currentPlayer } from "../state.ts";
import { useAppState } from "../store.ts";
import type { StoreItem } from "../types.ts";

export function PlayPage() {
  const state = useAppState();
  const wheel = useRef<WheelHandle>(null);
  const [busy, setBusy] = useState<"spin" | "deposit" | null>(null);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [win, setWin] = useState<{ coins: number; key: number } | null>(null);
  const [message, setMessage] = useState("");
  const [scenes, setScenes] = useState(false);

  const tenant = state.tenants.find((t) => t.id === state.tenantId);
  const brand = tenant?.platform === "B" ? "beta" : "alpha";
  const player = currentPlayer(state);
  const me = player ? (state.meByPlayer[player.key] ?? null) : null;
  const segments = state.wheelByTenant[state.tenantId] ?? [];
  const items = state.itemsByTenant[state.tenantId] ?? [];
  const available = Number(me?.balance?.available ?? 0);
  const reserved = Number(me?.balance?.reserved ?? 0);
  const action = nextAction(me, items, rewardTitle);
  const mine = state.tracked.filter((t) => player && t.playerKey === player.key);

  if (state.boot === "error") {
    return (
      <main className="game" data-brand="alpha">
        <div className="notice" role="alert">
          <h1>The game is not reachable</h1>
          <p>
            We could not reach the casino simulator or the service. Check that the stack is running, then try
            again.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => boot()}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  const run = async (kind: "spin" | "deposit") => {
    setBusy(kind);
    setMessage("");
    setWin(null);
    try {
      if (kind === "deposit") {
        const res = await deposit();
        if (!res.ok) setMessage(res.message);
      } else {
        const res = await spin();
        if (!res.ok) {
          setMessage(res.message);
          return;
        }
        await wheel.current?.spinTo(res.segmentIndex);
        setWin({ coins: res.coins, key: Date.now() });
        await refreshMe("after-spin");
      }
    } finally {
      setBusy(null);
    }
  };

  const get = async (item: StoreItem) => {
    setRedeemingId(item.id);
    setMessage("");
    setWin(null);
    const res = await redeem(item, rewardTitle(item));
    if (!res.ok) setMessage(res.message);
    setRedeemingId(null);
  };

  const dimmed =
    win || busy === "spin"
      ? null
      : action.kind === "deposit"
        ? "Deposit to get a spin"
        : action.kind === "wait"
          ? "Getting your game ready"
          : action.kind === "reward"
            ? "No spins left"
            : null;

  const bestItem = action.kind === "reward" ? items.find((i) => i.id === action.itemId) : undefined;
  const primary =
    action.kind === "spin" ? (
      <button
        type="button"
        className="btn btn-primary btn-big"
        disabled={busy !== null}
        onClick={() => run("spin")}
      >
        {busy === "spin" ? "Spinning" : "Spin"}
        {action.spins > 1 && busy !== "spin" ? <span className="badge">{action.spins}</span> : null}
      </button>
    ) : action.kind === "wait" ? (
      <button type="button" className="btn btn-primary btn-big" disabled>
        One moment
      </button>
    ) : action.kind === "reward" && bestItem ? (
      <button
        type="button"
        className="btn btn-primary btn-big"
        disabled={redeemingId !== null}
        onClick={() => get(bestItem)}
      >
        {redeemingId ? "Getting it" : `Get ${rewardTitle(bestItem)}`}
      </button>
    ) : (
      <button
        type="button"
        className="btn btn-cashier btn-primary btn-big"
        disabled={busy !== null}
        onClick={() => run("deposit")}
      >
        {busy === "deposit" ? "Depositing" : "Deposit €20"}
      </button>
    );

  return (
    <main className="game" data-brand={brand}>
      <div className="game-bar">
        <DemoControls state={state} />
      </div>
      <header className="game-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <p className="brand-name">{tenant?.name ?? "Casino"}</p>
            <h1>Wheel of Fortune</h1>
          </div>
        </div>
        <div className="chip" aria-live="polite">
          <span className="coin-dot" aria-hidden="true" />
          <div>
            <p className="chip-label">Your coins</p>
            <p className="chip-value">{me?.balance ? <CountUp value={available} /> : "-"}</p>
          </div>
          {reserved > 0 ? <p className="chip-hold">{coins(reserved)} on hold</p> : null}
        </div>
      </header>

      <div className="game-grid">
        <section className="stage" aria-label="Wheel">
          <div className="wheel-wrap">
            {segments.length > 0 ? (
              <Wheel ref={wheel} segments={segments} dimmedText={dimmed} />
            ) : (
              <div className="wheel-skeleton" />
            )}
            {win ? <CoinBurst key={win.key} /> : null}
          </div>
          <div className="win-slot" aria-live="polite">
            {win ? (
              <p className="win">
                You won <strong>{coins(win.coins)} coins</strong>
              </p>
            ) : null}
          </div>
          {action.kind === "deposit" ? <p className="cashier-label">Casino cashier</p> : null}
          {primary}
          <p className="why">
            {message ? "" : busy === "spin" ? "The server has picked your prize." : action.why}
          </p>
          {action.kind === "reward" ? (
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy !== null}
              onClick={() => run("deposit")}
            >
              {busy === "deposit" ? "Depositing" : "Or deposit €20 at the cashier for another spin"}
            </button>
          ) : null}
          {message ? (
            <p className="problem" role="alert">
              {message}
            </p>
          ) : null}
          <p className="caption">The server picks the prize. The wheel only shows it.</p>
        </section>

        <Rewards
          items={items}
          available={available}
          bestId={action.kind === "reward" ? action.itemId : null}
          tracked={mine}
          busyId={redeemingId}
          onGet={get}
        />
      </div>

      <footer className="game-foot">
        <button
          type="button"
          className="btn btn-quiet"
          aria-expanded={scenes}
          onClick={() => setScenes(!scenes)}
        >
          See what happened behind the scenes
        </button>
      </footer>
      <BehindScenes open={scenes} onClose={() => setScenes(false)} log={state.log} items={items} />
    </main>
  );
}
