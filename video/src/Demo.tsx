// The short loop for the top of the README. Real footage underneath; on top of it, drawn here:
// a cursor that moves to each control the recording pressed, a zoom that follows the step, and a
// ring around the element the caption talks about. All positions are in source pixels (1920x1080
// page captures) and are mapped through the current zoom.
import type React from "react";
import { AbsoluteFill, Easing, Img, interpolate, OffthreadVideo, Series, staticFile, useCurrentFrame } from "remotion";
import { C, FONT, MONO } from "./theme";

const FPS = 30;
const s = (sec: number) => Math.round(sec * FPS);
const ease = Easing.inOut(Easing.cubic);

type Crop = { x: number; y: number; w: number };
type Key = { t: number; c: Crop };
type Pt = { t: number; x: number; y: number; click?: boolean };
type Ring = { from: number; to: number; x: number; y: number; w: number; h: number };
type Cap = { at: number; text: string };

const FW = 1760;
const FH = 880; // 2:1
const LEFT = (1920 - FW) / 2;
const TOP = 30;
const BAR = 40;

function cropAt(keys: Key[], t: number): Crop {
  if (t <= keys[0].t) return keys[0].c;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.t) {
      const k = ease((t - a.t) / Math.max(b.t - a.t, 0.001));
      return { x: a.c.x + (b.c.x - a.c.x) * k, y: a.c.y + (b.c.y - a.c.y) * k, w: a.c.w + (b.c.w - a.c.w) * k };
    }
  }
  return keys[keys.length - 1].c;
}

// The cursor holds still at each point and glides (0.4 s) to the next one before its time.
function cursorAt(pts: Pt[], t: number) {
  const GLIDE = 0.4;
  if (t <= pts[0].t) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    const a = pts[i - 1];
    if (t <= b.t) {
      const start = Math.max(a.t, b.t - GLIDE);
      const k = ease(Math.min(Math.max((t - start) / (b.t - start || 1), 0), 1));
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return pts[pts.length - 1];
}

const Pointer: React.FC<{ x: number; y: number }> = ({ x, y }) => (
  <svg width={40} height={40} viewBox="0 0 24 24" style={{ position: "absolute", left: x - 6, top: y - 3, filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.6))" }}>
    <path d="M5 2 L5 20 L10 15.5 L13.5 22 L16.5 20.5 L13 14 L19.5 14 Z" fill="#ffffff" stroke="#111" strokeWidth={1.2} strokeLinejoin="round" />
  </svg>
);

const Shot: React.FC<{
  src?: string;
  still?: string;
  from?: number;
  rate?: number;
  url: string;
  part: string;
  zoom: Key[];
  cursor?: Pt[];
  rings?: Ring[];
  caps: Cap[];
}> = ({ src, still, from = 0, rate = 1, url, part, zoom, cursor, rings = [], caps }) => {
  const f = useCurrentFrame();
  const t = f / FPS;
  const crop = cropAt(zoom, t);
  const scale = FW / crop.w;
  const map = (x: number, y: number) => ({ x: (x - crop.x) * scale, y: (y - crop.y) * scale });
  const idx = caps.reduce((acc, c, i) => (t >= c.at ? i : acc), 0);
  const capO = interpolate(f, [s(caps[idx].at), s(caps[idx].at) + 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const cur = cursor ? cursorAt(cursor, t) : null;
  const click = cursor?.find((p) => p.click && t >= p.t && t < p.t + 0.5);
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT, color: C.text }}>
      <div style={{ position: "absolute", left: LEFT, top: TOP, width: FW, borderRadius: 18, overflow: "hidden", border: `1px solid ${C.line}`, background: "#000" }}>
        <div style={{ height: BAR, background: C.panel, display: "flex", alignItems: "center", gap: 10, padding: "0 18px", borderBottom: `1px solid ${C.line}` }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: 13, height: 13, borderRadius: 7, background: C.line }} />
          ))}
          <div style={{ marginLeft: 18, fontFamily: MONO, fontSize: 22, color: C.muted, background: C.bg, padding: "4px 16px", borderRadius: 8 }}>{url}</div>
        </div>
        <div style={{ width: FW, height: FH, overflow: "hidden", position: "relative" }}>
          {still ? (
            <Img src={staticFile(still)} style={{ position: "absolute", left: -crop.x * scale, top: -crop.y * scale, width: 1920 * scale }} />
          ) : (
            <div style={{ position: "absolute", left: -crop.x * scale, top: -crop.y * scale, width: 1920 * scale, height: 1080 * scale }}>
              <OffthreadVideo src={staticFile(src ?? "")} trimBefore={s(from)} playbackRate={rate} muted style={{ width: "100%", height: "100%" }} />
            </div>
          )}
          {rings.map((r) => {
            const o = interpolate(t, [r.from, r.from + 0.3, r.to - 0.3, r.to], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            if (o <= 0) return null;
            const p = map(r.x, r.y);
            return (
              <div
                key={`${r.from}-${r.x}`}
                style={{
                  position: "absolute",
                  left: p.x - 8,
                  top: p.y - 8,
                  width: r.w * scale + 16,
                  height: r.h * scale + 16,
                  borderRadius: 14,
                  border: `4px solid ${C.violet}`,
                  boxShadow: `0 0 0 9999px rgba(8,9,14,${0.45 * o}), 0 0 24px ${C.violet}`,
                  opacity: o,
                }}
              />
            );
          })}
          {click
            ? (() => {
                const p = map(click.x, click.y);
                const k = (t - click.t) / 0.5;
                return (
                  <div
                    style={{
                      position: "absolute",
                      left: p.x - 10 - 40 * k,
                      top: p.y - 10 - 40 * k,
                      width: 20 + 80 * k,
                      height: 20 + 80 * k,
                      borderRadius: "50%",
                      border: `4px solid ${C.violet}`,
                      opacity: 1 - k,
                    }}
                  />
                );
              })()
            : null}
          {cur
            ? (() => {
                const p = map(cur.x, cur.y);
                return <Pointer x={p.x} y={p.y} />;
              })()
            : null}
        </div>
      </div>
      <div style={{ position: "absolute", left: LEFT, right: LEFT, top: TOP + BAR + FH + 30, display: "flex", alignItems: "center", gap: 28 }}>
        <div style={{ fontSize: 30, letterSpacing: 3, textTransform: "uppercase", color: C.accent, fontWeight: 700, whiteSpace: "nowrap", borderRight: `2px solid ${C.line}`, paddingRight: 28 }}>{part}</div>
        <div style={{ fontSize: 46, fontWeight: 500, opacity: capO }}>{caps[idx].text}</div>
      </div>
    </AbsoluteFill>
  );
};

// ---------- the three parts; times are seconds of this shot, positions are source pixels ----------

const PLAY = "localhost/app/#/play";
const PANEL = "localhost · fake casino control panel";
const ADMIN = "localhost/app/#/admin";
const WIDE: Crop = { x: 230, y: 20, w: 1690 };
const WHEEL: Crop = { x: 330, y: 230, w: 1300 };
const CARD: Crop = { x: 700, y: 180, w: 1000 };

// play-alpha.mp4 from 7.9 s at 1.5x: deposit pressed at 0.72, spin at 1.43, wheel stops near 4.6,
// "Get Bonus" pressed at 6.16. The second shot continues at normal speed until "In your casino account".
const SHOTS: { dur: number; el: React.ReactNode }[] = [
  {
    dur: s(6.4),
    el: (
      <Shot
        src="clips/play-alpha.mp4"
        from={7.9}
        rate={1.5}
        url={PLAY}
        part="Player"
        zoom={[
          { t: 0, c: WIDE },
          { t: 0.9, c: WIDE },
          { t: 1.6, c: WHEEL },
          { t: 4.4, c: WHEEL },
          { t: 5.2, c: { x: 330, y: 150, w: 1400 } },
        ]}
        cursor={[
          { t: 0, x: 1500, y: 300 },
          { t: 0.72, x: 1849, y: 110, click: true },
          { t: 1.43, x: 764, y: 889, click: true },
          { t: 4.8, x: 1100, y: 600 },
          { t: 6.16, x: 764, y: 889, click: true },
        ]}
        rings={[
          { from: 0.2, to: 1.0, x: 1785, y: 90, w: 125, h: 42 },
          { from: 4.5, to: 5.9, x: 1310, y: 258, w: 135, h: 44 },
        ]}
        caps={[
          { at: 0, text: "A deposit gives the player a spin." },
          { at: 1.4, text: "The server picks the prize." },
          { at: 4.5, text: "Coins are credited in the ledger." },
          { at: 5.8, text: "The player takes a bonus." },
        ]}
      />
    ),
  },
  {
    dur: s(3),
    el: (
      <Shot
        src="clips/play-alpha.mp4"
        from={17.5}
        url={PLAY}
        part="Player"
        zoom={[
          { t: 0, c: { x: 330, y: 150, w: 1400 } },
          { t: 0.8, c: CARD },
        ]}
        cursor={[{ t: 0, x: 764, y: 889 }, { t: 0.8, x: 1000, y: 740 }]}
        rings={[{ from: 0.9, to: 3.0, x: 1095, y: 497, w: 260, h: 32 }]}
        caps={[{ at: 0, text: "Issued: the bonus is in the casino account." }]}
      />
    ),
  },
  // fail-arm.mp4 from 0.6: "Switch on" pressed at 0.91.
  {
    dur: s(2.4),
    el: (
      <Shot
        src="clips/fail-arm.mp4"
        from={0.6}
        url={PANEL}
        part="Failure"
        zoom={[
          { t: 0, c: { x: 420, y: 120, w: 1100 } },
          { t: 0.9, c: { x: 430, y: 230, w: 1020 } },
        ]}
        cursor={[{ t: 0, x: 1000, y: 500 }, { t: 0.91, x: 1384, y: 331, click: true }]}
        rings={[
          { from: 0, to: 2.4, x: 438, y: 266, w: 724, h: 88 },
          { from: 1.1, to: 2.4, x: 1172, y: 355, w: 205, h: 24 },
        ]}
        caps={[{ at: 0, text: "Fault on: the casino's answer will be lost." }]}
      />
    ),
  },
  // fail-redeem.mp4 from 0.5: "Get Bonus" pressed at 0.72; issued shows near 3.0.
  {
    dur: s(3.5),
    el: (
      <Shot
        src="clips/fail-redeem.mp4"
        from={0.5}
        url={PLAY}
        part="Failure"
        zoom={[
          { t: 0, c: WHEEL },
          { t: 1.2, c: WHEEL },
          { t: 2.0, c: CARD },
        ]}
        cursor={[{ t: 0, x: 900, y: 700 }, { t: 0.72, x: 764, y: 846, click: true }, { t: 2.0, x: 1000, y: 700 }]}
        rings={[{ from: 2.3, to: 3.5, x: 1095, y: 455, w: 260, h: 32 }]}
        caps={[
          { at: 0, text: "The player takes a bonus. No answer comes back." },
          { at: 1.8, text: "We ask the casino and find the bonus." },
        ]}
      />
    ),
  },
  // fail-check.mp4 from 4.4: the panel has scrolled to the record and the check result.
  {
    dur: s(3.0),
    el: (
      <Shot
        src="clips/fail-check.mp4"
        from={4.4}
        url={PANEL}
        part="Failure"
        zoom={[
          { t: 0, c: { x: 280, y: 330, w: 1400 } },
          { t: 1.2, c: { x: 280, y: 330, w: 1400 } },
          { t: 2.0, c: { x: 330, y: 520, w: 1100 } },
        ]}
        rings={[
          { from: 0.1, to: 1.4, x: 442, y: 505, w: 1040, h: 30 },
          { from: 1.7, to: 3.0, x: 440, y: 775, w: 760, h: 262 },
        ]}
        caps={[{ at: 0, text: "Answer lost. One bonus. Player charged once." }]}
      />
    ),
  },
  // admin.mp4 from 3.0: the overview after sign-in.
  {
    dur: s(2.2),
    el: (
      <Shot
        src="clips/admin.mp4"
        from={3.0}
        url={ADMIN}
        part="Back office"
        zoom={[
          { t: 0, c: { x: 190, y: 40, w: 1720 } },
          { t: 1.0, c: { x: 200, y: 50, w: 1300 } },
        ]}
        rings={[{ from: 0.8, to: 2.2, x: 785, y: 212, w: 540, h: 28 }]}
        caps={[{ at: 0, text: "The back office: the tenant at a glance." }]}
      />
    ),
  },
  // The redemption's detail page (full-page screenshot), then its audit trail.
  {
    dur: s(4.8),
    el: (
      <Shot
        still="stills/audit.jpg"
        url={ADMIN}
        part="Back office"
        zoom={[
          { t: 0, c: { x: 180, y: 40, w: 1740 } },
          { t: 1.4, c: { x: 180, y: 40, w: 1740 } },
          { t: 2.4, c: { x: 200, y: 600, w: 1300 } },
        ]}
        rings={[
          { from: 0.2, to: 1.5, x: 190, y: 120, w: 760, h: 70 },
          { from: 2.6, to: 4.8, x: 960, y: 985, w: 540, h: 92 },
        ]}
        caps={[
          { at: 0, text: "That redemption: issued, settled once." },
          { at: 2.2, text: "Audit: issue failed, the look-up found it." },
        ]}
      />
    ),
  },
];

export const DEMO_FRAMES = SHOTS.reduce((a, b) => a + b.dur, 0);
export const DEMO_HEIGHT = 1080;
export const Demo: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    <Series>
      {SHOTS.map((sh, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
        <Series.Sequence key={i} durationInFrames={sh.dur}>
          {sh.el}
        </Series.Sequence>
      ))}
    </Series>
  </AbsoluteFill>
);
