import { coins, rewardTitle } from "../format.ts";
import { playerStatus } from "../status.ts";
import type { StoreItem, Tracked } from "../types.ts";

interface Props {
  items: StoreItem[];
  available: number;
  /** The id of the reward the player should take now, if any. */
  bestId: string | null;
  /** The player's redemptions, newest first. */
  tracked: Tracked[];
  busyId: string | null;
  onGet: (item: StoreItem) => void;
}

export function Rewards({ items, available, bestId, tracked, busyId, onGet }: Props) {
  return (
    <section className="rewards" aria-labelledby="rewards-title">
      <h2 id="rewards-title">Rewards</h2>
      <ul className="reward-list">
        {items.map((item) => {
          const cost = Number(item.costCoins);
          const title = rewardTitle(item);
          const can = available >= cost;
          const latest = tracked.find((t) => t.itemName === title);
          const status = latest?.data ? playerStatus(latest.data.status) : null;
          const pct = Math.min(100, Math.round((available / cost) * 100));
          const isBest = item.id === bestId;
          return (
            <li key={item.id} className={`reward${can ? " is-affordable" : ""}${isBest ? " is-best" : ""}`}>
              <div className="reward-top">
                <h3>{title}</h3>
                <p className="reward-price">
                  <span className="coin-dot" aria-hidden="true" />
                  <span className="tabular">{coins(cost)}</span> coins
                </p>
              </div>
              {can ? null : (
                <>
                  <div
                    className="meter"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={cost}
                    aria-valuenow={Math.min(available, cost)}
                    aria-label={`Coins toward ${title}`}
                  >
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  <p className="reward-need">{coins(cost - available)} more coins to go</p>
                </>
              )}
              <button
                type="button"
                className={`btn ${isBest ? "btn-primary" : "btn-secondary"}`}
                disabled={!can || busyId !== null}
                onClick={() => onGet(item)}
              >
                {busyId === item.id ? "Getting it" : "Get it"}
              </button>
              {status ? (
                <p className={`reward-status tone-${status.tone}`} role="status">
                  {status.tone === "wait" ? (
                    <span className="dots" aria-hidden="true" />
                  ) : (
                    <span className="tl-mark" aria-hidden="true" />
                  )}
                  {status.text}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
