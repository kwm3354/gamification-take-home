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

const DEPOSIT_MINOR = 2000;

const euro = (minor: number): string => `\u20ac${(minor / 100).toFixed(2)}`;

export function PlayPage() {
  const state = useAppState();
  const wheel = useRef<WheelHandle>(null);
  const [busy, setBusy] = useState<"spin" | "deposit" | null>(null);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [win, setWin] = useState<{ coins: number; key: number } | null>(null);
  const [message, setMessage] = useState("");
  const [scenes, setScenes] = useState(false);
  // The casino's own wallet, in cents. A demo figure kept in this page: each deposit adds 20.00.
  const [wallets, setWallets] = useState<Record<string, number>>({});

  const tenant = state.tenants.find((t) => t.id === state.tenantId);
  const brand = tenant?.platform === "B" ? "beta" : "alpha";
  const player = currentPlayer(state);
  const me = player ? (state.meByPlayer[player.key] ?? null) : null;
  const segments = state.wheelByTenant[state.tenantId] ?? [];
  const items = state.itemsByTenant[state.tenantId] ?? [];
  const available = Number(me?.balance?.available ?? 0);
  const reserved = Number(me?.balance?.reserved ?? 0);
  const action = nextAction(me, items, rewardTitle);
  const wallet = player ? (wallets[player.key] ?? 0) : 0;
  const mine = state.tracked.filter((t) => player && t.playerKey === player.key);

  if (state.boot === "error") {
    return (
      <div className="game" data-brand="alpha">
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
      </div>
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
        else if (player) setWallets((w) => ({ ...w, [player.key]: (w[player.key] ?? 0) + DEPOSIT_MINOR }));
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
        ? "No spin yet"
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
      <p className="deposit-cta">
        Make a deposit to get a spin
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M5 13 L13 5 M7 5 H13 V11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
        </svg>
      </p>
    );

  return (
    <div className="game" data-brand={brand}>
      <div className="site-demo">
        <span>Demo: the page below is a mock of a casino's website.</span>
        <DemoControls state={state} />
      </div>
      <header className="site-bar">
        <p className="site-name">
          <span className="site-mark" aria-hidden="true" />
          {tenant?.name ?? "Casino"}
        </p>
        <nav className="site-nav" aria-label="Casino sections (not active in this demo)">
          <span>Slots</span>
          <span>Live</span>
          <span>Promotions</span>
        </nav>
        <div className="site-account">
          <p className="site-wallet">
            <span>Wallet</span>
            <strong>{euro(wallet)}</strong>
          </p>
          <button
            type="button"
            className={`site-deposit${action.kind === "deposit" && busy === null ? " is-pointed" : ""}`}
            disabled={busy !== null}
            onClick={() => run("deposit")}
          >
            {busy === "deposit" ? "Depositing" : "Deposit \u20ac20"}
          </button>
        </div>
      </header>

      <main className="site-body">
        <h1 className="site-page-title">Promotions</h1>
        <section className="widget" aria-labelledby="widget-label">
          <p className="widget-label" id="widget-label">
            Wheel of Fortune - a gamification widget
          </p>
          <div className="widget-inner">
            <div className="widget-top">
              <div className="chip" aria-live="polite">
                <span className="coin-dot" aria-hidden="true" />
                <span className="chip-label">Your coins</span>
                <span className="chip-value">{me?.balance ? <CountUp value={available} /> : "-"}</span>
                {reserved > 0 ? <span className="chip-hold">{coins(reserved)} on hold</span> : null}
              </div>
            </div>
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
                {primary}
                <p className="why">
                  {message ? "" : busy === "spin" ? "The server has picked your prize." : action.why}
                </p>
                {action.kind === "reward" ? (
                  <p className="muted">For another spin, make a deposit with the casino's button at the top.</p>
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
          </div>
        </section>
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
      </main>
      <BehindScenes open={scenes} onClose={() => setScenes(false)} log={state.log} items={items} />
    </div>
  );
}
