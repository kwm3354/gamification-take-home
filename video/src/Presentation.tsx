import type React from "react";
import { AbsoluteFill, Img, interpolate, OffthreadVideo, Series, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { C, FONT, MONO } from "./theme";
import { type Lang, LangContext, useTr } from "./i18n";
import { ArchitectureScene } from "./Architecture";

const FPS = 30;
const s = (sec: number) => Math.round(sec * FPS);

// ---------- building blocks ----------

// Fades a whole scene in and out over a few frames.
const Fade: React.FC<{ children: React.ReactNode; dur: number }> = ({ children, dur }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 12, dur - 12, dur], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

// Fades and lifts an element in, starting at `at` frames.
const Rise: React.FC<{ at: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at, children, style }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return <div style={{ opacity: p, transform: `translateY(${(1 - p) * 18}px)`, ...style }}>{children}</div>;
};

const Page: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: C.bg, color: C.text, fontFamily: FONT }}>{children}</AbsoluteFill>
);

const Kicker: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const tr = useTr();
  return <div style={{ fontSize: 28, letterSpacing: 3, textTransform: "uppercase", color: C.accent, fontWeight: 600 }}>{typeof children === "string" ? tr(children) : children}</div>;
};

const SlideTitle: React.FC<{ kicker: string; title: string }> = ({ kicker, title }) => {
  const tr = useTr();
  return (
    <Rise at={0}>
      <Kicker>{kicker}</Kicker>
      <div style={{ fontSize: 64, fontWeight: 700, marginTop: 14, lineHeight: 1.15 }}>{tr(title)}</div>
    </Rise>
  );
};

const Bullets: React.FC<{ items: string[]; start: number; gap?: number; size?: number }> = ({ items, start, gap = 20, size = 40 }) => {
  const tr = useTr();
  return (
  <div style={{ display: "flex", flexDirection: "column", gap: 26, marginTop: 56 }}>
    {items.map((t, i) => (
      <Rise key={t} at={start + i * gap}>
        <div style={{ display: "flex", gap: 24, alignItems: "baseline", fontSize: size, lineHeight: 1.35 }}>
          <div style={{ width: 14, height: 14, borderRadius: 7, background: C.accent, flex: "none", transform: "translateY(-6px)" }} />
          <div>{tr(t)}</div>
        </div>
      </Rise>
    ))}
  </div>
  );
};

type Crop = { x: number; y: number; w: number };
type Cap = { at: number; text: string };

// Real footage inside a simple browser frame, with a lower-third caption.
const Footage: React.FC<{
  src: string;
  from: number; // seconds into the clip
  url: string;
  kicker: string;
  caps: Cap[]; // `at` in seconds from the start of this segment
  crop?: Crop; // source pixels; height follows the 16:9 frame
  cropTo?: Crop; // for a still: pan from `crop` to this one
  still?: string; // a full-page screenshot instead of a clip
  rate?: number;
  fw?: number; // frame width
  fh?: number; // frame height (page area, without the bar)
}> = ({ src, from, url, kicker, caps, crop: crop0 = { x: 0, y: 0, w: 1920 }, cropTo, still, rate = 1, fw = 1500, fh }) => {
  const f = useCurrentFrame();
  const tr = useTr();
  const k = cropTo ? interpolate(f, [s(1.6), s(3.4)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) }) : 0;
  const crop = cropTo ? { x: crop0.x + (cropTo.x - crop0.x) * k, y: crop0.y + (cropTo.y - crop0.y) * k, w: crop0.w + (cropTo.w - crop0.w) * k } : crop0;
  const FW = fw;
  const FH = fh ?? Math.round((FW * 9) / 16);
  const scale = FW / crop.w;
  const t = f / FPS;
  const idx = caps.reduce((acc, c, i) => (t >= c.at ? i : acc), 0);
  const capStart = s(caps[idx].at);
  const capO = interpolate(f, [capStart, capStart + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Page>
      <div style={{ position: "absolute", left: (1920 - FW) / 2, top: 34, width: FW, borderRadius: 18, overflow: "hidden", border: `1px solid ${C.line}`, boxShadow: "0 20px 60px rgba(0,0,0,0.5)", background: "#000" }}>
        <div style={{ height: 40, background: C.panel, display: "flex", alignItems: "center", gap: 10, padding: "0 18px", borderBottom: `1px solid ${C.line}` }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: 13, height: 13, borderRadius: 7, background: C.line }} />
          ))}
          <div style={{ marginLeft: 18, fontFamily: MONO, fontSize: 20, color: C.muted, background: C.bg, padding: "4px 16px", borderRadius: 8 }}>{url}</div>
        </div>
        <div style={{ width: FW, height: FH, overflow: "hidden", position: "relative" }}>
          {still ? (
            <Img src={staticFile(still)} style={{ position: "absolute", left: -crop.x * scale, top: -crop.y * scale, width: 1920 * scale }} />
          ) : (
            <div style={{ position: "absolute", left: -crop.x * scale, top: -crop.y * scale, width: 1920 * scale, height: 1080 * scale }}>
              <OffthreadVideo src={staticFile(src)} trimBefore={s(from)} playbackRate={rate} muted style={{ width: "100%", height: "100%" }} />
            </div>
          )}
        </div>
      </div>
      <div style={{ position: "absolute", left: (1920 - FW) / 2, right: (1920 - FW) / 2, top: 34 + 40 + FH + 26, display: "flex", alignItems: "center", gap: 28 }}>
        <div style={{ fontSize: 24, letterSpacing: 2.5, textTransform: "uppercase", color: C.accent, fontWeight: 700, whiteSpace: "nowrap", borderRight: `2px solid ${C.line}`, paddingRight: 28 }}>{tr(kicker)}</div>
        <div style={{ fontSize: 40, lineHeight: 1.2, opacity: capO, fontWeight: 500 }}>{tr(caps[idx].text)}</div>
      </div>
    </Page>
  );
};

// ---------- scenes ----------

const Title = () => {
  const tr = useTr();
  return (
  <Page>
    <AbsoluteFill style={{ padding: "0 160px", justifyContent: "center" }}>
      <Rise at={4}>
        <Kicker>A working slice</Kicker>
      </Rise>
      <Rise at={10}>
        <div style={{ fontSize: 92, fontWeight: 700, marginTop: 20, lineHeight: 1.1 }}>{tr("Gamification for casino operators")}</div>
      </Rise>
      <Rise at={22}>
        <div style={{ fontSize: 44, color: C.muted, marginTop: 36 }}>{tr("deposit → wheel → coins → bonus, across two casino platforms")}</div>
      </Rise>
    </AbsoluteFill>
  </Page>
  );
};

const Problem = () => (
  <Page>
    <AbsoluteFill style={{ padding: "120px 160px" }}>
      <SlideTitle kicker="The problem" title="Two casinos, two different APIs, and coins that act like money" />
      <Bullets
        start={18}
        gap={22}
        items={[
          "Alpha (platform A) answers at once and accepts an idempotency key.",
          "Beta (platform B) accepts, then reports the result later by webhook. No idempotency key.",
          "The casino may answer late, twice, or never.",
          "Rules: no bonus issued twice. No negative balance.",
        ]}
      />
    </AbsoluteFill>
  </Page>
);

// A box of the architecture drawing.
const Box: React.FC<{ x: number; y: number; w: number; h: number; at: number; title: string; lines?: string[]; tone?: "ours" | "outside" | "store" }> = ({ x, y, w, h, at, title, lines = [], tone = "ours" }) => {
  const border = tone === "ours" ? C.accent : tone === "store" ? C.good : C.muted;
  const dashed = tone === "outside";
  const tr = useTr();
  return (
    <Rise at={at} style={{ position: "absolute", left: x, top: y, width: w, height: h }}>
      <div style={{ width: w, height: h, boxSizing: "border-box", border: `2px ${dashed ? "dashed" : "solid"} ${border}`, borderRadius: 14, background: C.panel, padding: "16px 22px" }}>
        <div style={{ fontSize: 32, fontWeight: 700, color: tone === "ours" ? C.accent : tone === "store" ? C.good : C.text }}>{tr(title)}</div>
        {lines.map((l) => (
          <div key={l} style={{ fontSize: 25, color: C.muted, marginTop: 6, lineHeight: 1.3 }}>
            {tr(l)}
          </div>
        ))}
      </div>
    </Rise>
  );
};

const Arrow: React.FC<{ x1: number; y1: number; x2: number; y2: number; at: number; label?: string; dashed?: boolean }> = ({ x1, y1, x2, y2, at, label, dashed }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const xe = x1 + (x2 - x1) * p;
  const ye = y1 + (y2 - y1) * p;
  return (
    <g opacity={p > 0 ? 1 : 0}>
      <line x1={x1} y1={y1} x2={xe} y2={ye} stroke={C.muted} strokeWidth={3} strokeDasharray={dashed ? "10 8" : undefined} markerEnd={p > 0.95 ? "url(#head)" : undefined} />
      {label ? (
        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 12} fill={C.text} fontSize={22} textAnchor="middle" opacity={p} fontFamily={FONT}>
          {label}
        </text>
      ) : null}
    </g>
  );
};

const Architecture = () => {
  const tr = useTr();
  return (
  <Page>
    <div style={{ position: "absolute", left: 100, top: 50 }}>
      <SlideTitle kicker="Architecture" title="One domain model, one adapter per platform" />
    </div>
    <Box x={100} y={300} w={460} h={170} at={10} tone="outside" title="Casino Alpha" lines={["platform A, simulated", "answers at once"]} />
    <Box x={100} y={510} w={460} h={170} at={14} tone="outside" title="Casino Beta" lines={["platform B, simulated", "result later by webhook"]} />
    <Box x={100} y={720} w={460} h={170} at={18} tone="outside" title="Player and staff" lines={["widget on the casino page", "back office: sign-in, roles"]} />
    <Box
      x={700}
      y={300}
      w={620}
      h={590}
      at={24}
      title="Our service"
      lines={[
        "Adapter A · Adapter B",
        "Events → spins → coins",
        "Store: redemption state machine",
        "Outbox jobs with leases",
        "Workers scale by count",
        "Audit trail · alerts · keys",
      ]}
    />
    <Box x={1460} y={300} w={360} h={270} at={34} tone="store" title="PostgreSQL" lines={["state, outbox,", "audit log"]} />
    <Box x={1460} y={620} w={360} h={270} at={40} tone="store" title="TigerBeetle" lines={["coin ledger,", "double entry,", "pending / post / void"]} />
    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
      <defs>
        <marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill={C.muted} />
        </marker>
      </defs>
      <Arrow x1={560} y1={385} x2={700} y2={385} at={30} />
      <Arrow x1={560} y1={595} x2={700} y2={595} at={32} />
      <Arrow x1={560} y1={805} x2={700} y2={805} at={34} />
      <Arrow x1={1320} y1={435} x2={1460} y2={435} at={44} />
      <Arrow x1={1320} y1={755} x2={1460} y2={755} at={46} />
    </svg>
    <Rise at={60} style={{ position: "absolute", left: 100, top: 950, fontSize: 32, color: C.muted }}>
      {tr("No transaction spans the two stores: PostgreSQL first, then the ledger with a fixed transfer id.")}
    </Rise>
  </Page>
  );
};

const Pill: React.FC<{ x: number; y: number; at: number; title: string; sub: string; tone?: "ours" | "store" | "bad" }> = ({ x, y, at, title, sub, tone = "ours" }) => {
  const col = tone === "store" ? C.good : tone === "bad" ? C.bad : C.accent;
  const tr = useTr();
  return (
    <Rise at={at} style={{ position: "absolute", left: x, top: y, width: 270 }}>
      <div style={{ border: `2px solid ${col}`, borderRadius: 14, background: C.panel, padding: "14px 18px", textAlign: "center" }}>
        <div style={{ fontSize: 34, fontWeight: 700, color: col }}>{title}</div>
        <div style={{ fontSize: 24, color: C.muted, marginTop: 4 }}>{tr(sub)}</div>
      </div>
    </Rise>
  );
};

const Lifecycle = () => {
  const ru = useTr()("final") !== "final";
  return (
  <Page>
    <div style={{ position: "absolute", left: 100, top: 50 }}>
      <SlideTitle kicker="The life of a redemption" title="Coins are held, not spent, until the casino answers" />
    </div>
    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
      <defs>
        <marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill={C.muted} />
        </marker>
      </defs>
      <Arrow x1={370} y1={470} x2={430} y2={470} at={14} />
      <Arrow x1={700} y1={470} x2={760} y2={470} at={20} />
      <Arrow x1={1030} y1={450} x2={1110} y2={385} at={26} />
      <Arrow x1={1030} y1={490} x2={1110} y2={575} at={26} />
      <Arrow x1={1380} y1={385} x2={1440} y2={385} at={34} />
      <Arrow x1={1380} y1={575} x2={1440} y2={575} at={34} />
    </svg>
    <Pill x={100} y={420} at={8} title="created" sub="intent + job" />
    <Pill x={430} y={420} at={14} title="reserved" sub="coins held" />
    <Pill x={760} y={420} at={20} title="submitting" sub="asking the casino" />
    <Pill x={1110} y={335} at={26} title="issued" sub="final" />
    <Pill x={1110} y={525} at={26} title="refused" sub="final" tone="bad" />
    <Pill x={1440} y={335} at={34} title="settled" sub="coins captured" tone="store" />
    <Pill x={1440} y={525} at={34} title="settled" sub="coins released" tone="store" />
    <Rise at={44} style={{ position: "absolute", left: 100, top: 740, fontSize: 40, lineHeight: 1.4 }}>
      {ru ? (
        <>
          Ответ неизвестен: заявка остаётся в <b style={{ color: C.accent }}>submitting</b>. Сначала спросить казино, потом повторять.
          <div style={{ color: C.muted, fontSize: 34, marginTop: 10 }}>Таймаут или ошибка никогда не отклоняют заявку.</div>
        </>
      ) : (
        <>
          Unknown answer: stay in <b style={{ color: C.accent }}>submitting</b>. Look first, then repeat.
          <div style={{ color: C.muted, fontSize: 34, marginTop: 10 }}>A timeout or an error never refuses a redemption.</div>
        </>
      )}
    </Rise>
  </Page>
  );
};

const SectionCard: React.FC<{ kicker: string; title: string }> = ({ kicker, title }) => {
  const tr = useTr();
  return (
  <Page>
    <AbsoluteFill style={{ padding: "0 160px", justifyContent: "center" }}>
      <Rise at={2}>
        <Kicker>{kicker}</Kicker>
      </Rise>
      <Rise at={8}>
        <div style={{ fontSize: 76, fontWeight: 700, marginTop: 18, lineHeight: 1.15 }}>{tr(title)}</div>
      </Rise>
    </AbsoluteFill>
  </Page>
  );
};

const Evidence = () => {
  const tr = useTr();
  return (
  <Page>
    <AbsoluteFill style={{ padding: "90px 160px" }}>
      <SlideTitle kicker="Evidence" title="Measured and tested, not estimated" />
      <div style={{ display: "flex", gap: 90, marginTop: 50 }}>
        <Rise at={14} style={{ flex: 1 }}>
          <div style={{ fontSize: 32, color: C.muted, marginBottom: 18 }}>{tr("500 redemptions, 64 at once. Time from the last request to the last final answer:")}</div>
          {[
            ["1 worker", "7.1 s", 1],
            ["2 workers", "3.4 s", 3.4 / 7.1],
            ["4 workers", "1.8 s", 1.8 / 7.1],
          ].map(([label, v, share], i) => (
            <Rise key={label as string} at={20 + i * 8}>
              <div style={{ display: "flex", alignItems: "center", gap: 22, marginTop: 16 }}>
                <div style={{ width: 190, fontSize: 34 }}>{tr(label as string)}</div>
                <div style={{ height: 40, width: 380 * (share as number), background: C.accent, borderRadius: 6 }} />
                <div style={{ fontSize: 34, fontWeight: 700 }}>{tr(v as string)}</div>
              </div>
            </Rise>
          ))}
          <div style={{ fontSize: 26, color: C.muted, marginTop: 22 }}>{tr("All 1500 ended issued, none twice. One run per row, busy machine (docs/performance.md).")}</div>
        </Rise>
        <div style={{ flex: 1 }}>
          <Bullets
            start={40}
            gap={14}
            size={34}
            items={[
              "369 backend tests and 105 web tests, all green.",
              "A fake casino that loses answers; a judge that reads only the casino's record and the ledger.",
              "Mutation checks: the code is broken on purpose and the tests must fail.",
              "CI runs the tests and starts the compose stack.",
            ]}
          />
        </div>
      </div>
    </AbsoluteFill>
  </Page>
  );
};

const HowMade = () => (
  <Page>
    <AbsoluteFill style={{ padding: "120px 160px" }}>
      <SlideTitle kicker="How it was made" title="One engineer, one day, AI agents doing the typing" />
      <Bullets
        start={18}
        gap={20}
        items={[
          "AI agents worked from written briefs, each in its own branch.",
          "Product and design decisions were made by the engineer.",
          "Every change has a row in the decision log: who decided, how it was checked.",
        ]}
      />
    </AbsoluteFill>
  </Page>
);

const Close = () => (
  <Page>
    <AbsoluteFill style={{ padding: "110px 160px" }}>
      <SlideTitle kicker="Where the prototype ends" title="Everything the task asks is built and tested" />
      <Bullets
        start={16}
        gap={16}
        size={36}
        items={[
          "Simulated, as the task asks: both casino platforms.",
          "Outside the task, for production: database-level tenant isolation, a secrets store, schema migrations, delivery of alerts.",
          "Outside the task, product decisions not made yet: missions, coin expiry, revoking a reward.",
        ]}
      />
      <Rise at={70}>
        <div style={{ marginTop: 70, display: "inline-block", fontFamily: MONO, fontSize: 46, background: C.panel, border: `2px solid ${C.accent}`, borderRadius: 14, padding: "18px 34px" }}>
          docker compose up -d --build --wait
        </div>
      </Rise>
    </AbsoluteFill>
  </Page>
);

// ---------- timeline ----------

const PLAY = "localhost/app/#/play";
const PANEL = "localhost · fake casino control panel";
const ADMIN = "localhost/app/#/admin";
const PLAYER_CROP: Crop = { x: 230, y: 135, w: 1461 };

const ALPHA_CAPS: Cap[] = [
          { at: 0, text: "The casino reports a deposit. The player gets a spin." },
          { at: 1.6, text: "The server picks the prize. The wheel only shows it." },
          { at: 6.4, text: "The coins are credited in the ledger." },
          { at: 8.7, text: "The player takes a bonus. Alpha answers at once." },
          { at: 10.2, text: "Issued: the bonus is in the casino account." },
        ];

type Scene = { dur: number; el: React.ReactNode };
const SCENES: Scene[] = [
  { dur: s(4.5), el: <Title /> },
  { dur: s(8), el: <Problem /> },
  { dur: s(10), el: <ArchitectureScene /> },
  { dur: s(5.5), el: <Lifecycle /> },
  {
    dur: s(13),
    el: (
      <Footage
        src="clips/play-alpha.mp4"
        from={8.4}
        url={PLAY}
        kicker="It works · Alpha"
        crop={PLAYER_CROP}
        caps={ALPHA_CAPS}
      />
    ),
  },
  {
    dur: s(14.5),
    el: (
      <Footage
        src="clips/play-beta.mp4"
        from={16.0}
        url={PLAY}
        kicker="It works · Beta"
        crop={PLAYER_CROP}
        caps={[
          { at: 0, text: "Same widget, the other casino: Beta, platform B." },
          { at: 1.5, text: "Deposit, spin, coins. Same domain model." },
          { at: 8.7, text: "Beta accepts the request: “on its way”, coins on hold." },
          { at: 11.5, text: "The result arrives by webhook: in the casino account." },
        ]}
      />
    ),
  },
  { dur: s(3), el: <SectionCard kicker="It survives failure" title="The casino issues the bonus, but its answer is lost" /> },
  {
    dur: s(4.2),
    el: <Footage src="clips/fail-arm.mp4" from={0.3} url={PANEL} crop={{ x: 420, y: 0, w: 1100 }} kicker="Failure" caps={[{ at: 0, text: "On the fake casino panel: switch the fault on." }]} />,
  },
  {
    dur: s(7.5),
    el: (
      <Footage
        src="clips/fail-redeem.mp4"
        from={0.6}
        url={PLAY}
        kicker="Failure"
        crop={PLAYER_CROP}
        caps={[
          { at: 0, text: "The player takes a bonus. The answer never comes back." },
          { at: 2.8, text: "We ask the casino, find the bonus, mark it issued." },
        ]}
      />
    ),
  },
  {
    dur: s(6.5),
    el: (
      <Footage
        still="stills/audit.jpg"
        src=""
        from={0}
        url={ADMIN}
        kicker="Audit trail"
        crop={{ x: 180, y: 40, w: 1740 }}
        cropTo={{ x: 190, y: 520, w: 1300 }}
        caps={[
          { at: 0, text: "The back office shows this redemption: issued, settled." },
          { at: 2.6, text: "Audit trail: the issue call failed, the look-up found the bonus." },
        ]}
      />
    ),
  },
  {
    dur: s(7),
    el: (
      <Footage
        src="clips/fail-check.mp4"
        from={0.3}
        url={PANEL}
        crop={{ x: 333, y: 370, w: 1227 }}
        kicker="Check"
        caps={[
          { at: 0, text: "The casino's own record: one bonus per reference." },
          { at: 3.0, text: "We charged the player once. Every check passed." },
        ]}
      />
    ),
  },
  {
    dur: s(5.6),
    el: (
      <Footage
        src="clips/admin.mp4"
        from={0.6}
        url={ADMIN}
        kicker="Operations"
        caps={[
          { at: 0, text: "Back office: real sign-in, roles per tenant." },
          { at: 2.6, text: "Overview: players, redemptions, jobs, alerts." },
        ]}
      />
    ),
  },
  {
    dur: s(6.7),
    el: (
      <Footage
        src="clips/admin.mp4"
        from={16.6}
        url={ADMIN}
        crop={{ x: 180, y: 290, w: 1400 }}
        kicker="Operations"
        caps={[
          { at: 0, text: "Settings → Keys: replace a tenant's signing key." },
          { at: 2.8, text: "The new key is shown once (blurred here)." },
        ]}
      />
    ),
  },
  { dur: s(8.5), el: <Evidence /> },
  { dur: s(7), el: <HowMade /> },
  { dur: s(8), el: <Close /> },
];

export const TOTAL_FRAMES = SCENES.reduce((a, b) => a + b.dur, 0);

export const Presentation: React.FC<{ lang?: Lang }> = ({ lang = "en" }) => {
  useVideoConfig();
  return (
    <LangContext.Provider value={lang}>
    <AbsoluteFill style={{ background: C.bg }}>
      <Series>
        {SCENES.map((sc, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
          <Series.Sequence key={i} durationInFrames={sc.dur}>
            <Fade dur={sc.dur}>{sc.el}</Fade>
          </Series.Sequence>
        ))}
      </Series>
    </AbsoluteFill>
    </LangContext.Provider>
  );
};
