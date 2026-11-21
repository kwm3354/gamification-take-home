const COINS = 14;

/** A short burst of coins from the middle of the wheel. Not drawn at all when motion is reduced (CSS). */
export function CoinBurst() {
  return (
    <div className="burst" aria-hidden="true">
      {Array.from({ length: COINS }, (_, i) => {
        const angle = (i / COINS) * 360 + (i % 2) * 11;
        return (
          <span
            key={i}
            className="burst-coin"
            style={{
              ["--a" as string]: `${angle}deg`,
              ["--d" as string]: `${110 + (i % 3) * 34}px`,
              animationDelay: `${(i % 4) * 30}ms`,
            }}
          />
        );
      })}
    </div>
  );
}
