import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Segment } from "../types.ts";
import { finalRotation } from "../wheel-rotation.ts";

export interface WheelHandle {
  /** Turns the wheel so slice `index` stops under the pointer. Resolves when it has stopped. */
  spinTo: (index: number) => Promise<void>;
}

const SPIN_MS = 4600;
const CX = 200;
const COLORS = 6;
const BULBS = 20;

const polar = (r: number, deg: number): [number, number] => {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.sin(rad), CX - r * Math.cos(rad)];
};

function slicePath(from: number, to: number, r: number): string {
  const [x1, y1] = polar(r, from);
  const [x2, y2] = polar(r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M${CX} ${CX} L${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The angle of an element's CSS rotation, 0..360. */
function angleOf(el: Element): number {
  const m = new DOMMatrix(getComputedStyle(el).transform);
  return ((((Math.atan2(m.b, m.a) * 180) / Math.PI) % 360) + 360) % 360;
}

interface Props {
  segments: Segment[];
  /** The wheel is dimmed and shows this text over its centre. */
  dimmedText: string | null;
  ref?: Ref<WheelHandle>;
}

export function Wheel({ segments, dimmedText, ref }: Props) {
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const rotor = useRef<SVGGElement>(null);
  const flapper = useRef<SVGGElement>(null);
  const rotationRef = useRef(0);
  const frame = useRef(0);
  const n = segments.length;
  const slice = 360 / Math.max(n, 1);

  useImperativeHandle(
    ref,
    () => ({
      spinTo: (index: number) =>
        new Promise<void>((resolve) => {
          const target = finalRotation(n, index, rotationRef.current);
          rotationRef.current = target;
          setRotation(target);
          if (prefersReducedMotion()) {
            resolve();
            return;
          }
          setSpinning(true);
          const done = window.setTimeout(() => {
            setSpinning(false);
            resolve();
          }, SPIN_MS + 120);
          // If the component goes away the timer is cleared by the effect below.
          timers.current.add(done);
        }),
    }),
    [n],
  );

  const timers = useRef(new Set<number>());
  useEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) window.clearTimeout(t);
    };
  }, []);

  // While the wheel turns, the pointer flicks each time a slice edge passes it.
  useEffect(() => {
    if (!spinning) return;
    const rotorEl = rotor.current;
    const flapEl = flapper.current;
    if (!rotorEl || !flapEl) return;
    let last = Math.floor(angleOf(rotorEl) / slice);
    const step = () => {
      const now = Math.floor(angleOf(rotorEl) / slice);
      if (now !== last) {
        last = now;
        flapEl.animate([{ transform: "rotate(-24deg)" }, { transform: "rotate(0deg)" }], {
          duration: 130,
          easing: "ease-out",
        });
      }
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [spinning, slice]);

  const reduced = typeof window !== "undefined" && prefersReducedMotion();

  return (
    <div className={`wheel${dimmedText ? " is-dim" : ""}${spinning ? " is-spinning" : ""}`}>
      <svg
        viewBox="0 0 400 400"
        role="img"
        aria-label={`Wheel of Fortune with ${n} prizes: ${segments.map((s) => s.label).join(", ")}`}
      >
        <defs>
          <radialGradient id="rim" cx="50%" cy="50%" r="50%">
            <stop offset="86%" stopColor="var(--rim-a)" />
            <stop offset="95%" stopColor="var(--rim-b)" />
            <stop offset="100%" stopColor="var(--rim-a)" />
          </radialGradient>
          <radialGradient id="shade" cx="50%" cy="50%" r="50%">
            <stop offset="55%" stopColor="#000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.38" />
          </radialGradient>
        </defs>
        <circle cx={CX} cy={CX} r="196" fill="url(#rim)" />
        <circle cx={CX} cy={CX} r="170" fill="var(--rim-inner)" />
        {Array.from({ length: BULBS }, (_, i) => {
          const [x, y] = polar(183, (i * 360) / BULBS);
          return <circle key={i} className={`bulb ${i % 2 ? "odd" : "even"}`} cx={x} cy={y} r="5" />;
        })}
        <g
          ref={rotor}
          className="rotor"
          style={{
            transform: `rotate(${rotation}deg)`,
            transformOrigin: `${CX}px ${CX}px`,
            transition: reduced ? "none" : `transform ${SPIN_MS}ms cubic-bezier(0.1, 0.55, 0.08, 1)`,
          }}
        >
          {segments.map((seg, i) => {
            const from = i * slice;
            const to = (i + 1) * slice;
            const mid = from + slice / 2;
            const left = mid > 180;
            return (
              <g key={`${seg.label}-${i}`}>
                <path
                  d={slicePath(from, to, 160)}
                  className="slice"
                  style={{ fill: `var(--seg-${i % COLORS})` }}
                />
                <g transform={`rotate(${left ? mid + 90 : mid - 90} ${CX} ${CX})`}>
                  <text
                    x={left ? CX - 136 : CX + 136}
                    y={CX + 7}
                    textAnchor={left ? "start" : "end"}
                    className="slice-label"
                  >
                    {seg.label}
                  </text>
                </g>
              </g>
            );
          })}
          <circle cx={CX} cy={CX} r="160" fill="url(#shade)" pointerEvents="none" />
        </g>
        <circle cx={CX} cy={CX} r="34" className="hub" />
        <circle cx={CX} cy={CX} r="20" className="hub-core" />
        <g ref={flapper} className="flapper" style={{ transformOrigin: `${CX}px 22px` }}>
          <path d="M200 60 L184 28 Q200 6 216 28 Z" className="flapper-body" />
          <circle cx={CX} cy="26" r="6" className="flapper-pin" />
        </g>
      </svg>
      {dimmedText ? <p className="wheel-note">{dimmedText}</p> : null}
    </div>
  );
}
