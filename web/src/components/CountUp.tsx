import { useEffect, useRef, useState } from "react";

/** Shows a number and rolls it up or down to a new value in about a second. */
export function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    const start = from.current;
    if (start === value || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = value;
      setShown(value);
      return;
    }
    const began = performance.now();
    let frame = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - began) / 1100);
      const eased = 1 - (1 - k) ** 3;
      const now = Math.round(start + (value - start) * eased);
      from.current = now;
      setShown(now);
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <span className="tabular">{shown.toLocaleString("en-US")}</span>;
}
