// The architecture scene: ports and adapters around one domain. Names and methods match
// src/domain/casino-platform.ts, src/domain/coin-ledger.ts, src/integrations/, src/ledger/,
// src/store/redemption.ts (confirm) and src/outbox/.
import type React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { useTr } from "./i18n";
import { C, FONT, MONO } from "./theme";

const fadeIn = (f: number, at: number) =>
  interpolate(f, [at, at + 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });

type Tone = "domain" | "item" | "port" | "adapter" | "outside" | "store";
const BORDER: Record<Tone, string> = {
  domain: C.accent,
  item: C.line,
  port: C.violet,
  adapter: C.accentDeep,
  outside: C.muted,
  store: C.good,
};

const Box: React.FC<{ x: number; y: number; w: number; h: number; at: number; tone: Tone; children: React.ReactNode; bg?: string }> = ({ x, y, w, h, at, tone, children, bg }) => {
  const f = useCurrentFrame();
  const o = fadeIn(f, at);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        boxSizing: "border-box",
        borderRadius: 14,
        border: `${tone === "port" || tone === "domain" ? 3 : 2}px ${tone === "outside" ? "dashed" : "solid"} ${BORDER[tone]}`,
        background: bg ?? C.panel,
        padding: "12px 16px",
        opacity: o,
        transform: `translateY(${(1 - o) * 10}px)`,
      }}
    >
      {children}
    </div>
  );
};

const Title: React.FC<{ children: React.ReactNode; color?: string; size?: number; mono?: boolean }> = ({ children, color = C.text, size = 28, mono }) => (
  <div style={{ fontSize: size, fontWeight: 700, color, fontFamily: mono ? MONO : FONT, lineHeight: 1.2 }}>{children}</div>
);
const Line: React.FC<{ children: React.ReactNode; color?: string; mono?: boolean; size?: number; bold?: boolean }> = ({ children, color = C.muted, mono, size = 22, bold }) => (
  <div style={{ fontSize: size, color, fontFamily: mono ? MONO : FONT, lineHeight: 1.3, marginTop: 3, fontWeight: bold ? 700 : 400 }}>{children}</div>
);

const Arrow: React.FC<{ d: string; at: number; both?: boolean }> = ({ d, at, both }) => {
  const f = useCurrentFrame();
  const o = fadeIn(f, at);
  return <path d={d} stroke={C.muted} strokeWidth={3} fill="none" opacity={o} markerEnd="url(#ah)" markerStart={both ? "url(#ah)" : undefined} />;
};

// The path one redemption takes, pulsed after the picture is built.
const PULSE: { x: number; y: number }[] = [
  { x: 430, y: 330 }, // adapter A (the request arrives)
  { x: 1050, y: 640 }, // the redemption in the domain
  { x: 1500, y: 433 }, // CoinLedger.reserve
  { x: 830, y: 433 }, // CasinoPlatform.issueReward
  { x: 1500, y: 465 }, // CoinLedger.capture
];
const PULSE_START = 200;
const PULSE_STEP = 20;

function pulseAt(f: number) {
  const t = (f - PULSE_START) / PULSE_STEP;
  if (t < 0 || t > PULSE.length - 1 + 0.6) return null;
  const i = Math.min(Math.floor(t), PULSE.length - 2);
  const k = Easing.inOut(Easing.cubic)(Math.min(Math.max(t - i, 0), 1));
  const a = PULSE[i];
  const b = PULSE[i + 1];
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, step: t };
}

// A method name lights up when the pulse reaches it.
const Method: React.FC<{ name: string; lit?: [number, number] }> = ({ name, lit }) => {
  const f = useCurrentFrame();
  const on = lit && f >= lit[0] && f < lit[1];
  return (
    <div style={{ fontFamily: MONO, fontSize: 22, lineHeight: 1.45, color: on ? C.text : C.muted, fontWeight: on ? 700 : 400, background: on ? "rgba(171,151,255,0.25)" : "transparent", borderRadius: 6, padding: "0 6px", marginLeft: -6 }}>
      {name}
    </div>
  );
};

export const ArchitectureScene: React.FC = () => {
  const f = useCurrentFrame();
  const tr = useTr();
  const p = pulseAt(f);
  const hit = (n: number) => [PULSE_START + n * PULSE_STEP - 4, PULSE_START + n * PULSE_STEP + 26] as [number, number];
  return (
    <AbsoluteFill style={{ background: C.bg, color: C.text, fontFamily: FONT }}>
      <div style={{ position: "absolute", left: 30, top: 28, opacity: fadeIn(f, 0) }}>
        <div style={{ fontSize: 26, letterSpacing: 3, textTransform: "uppercase", color: C.accent, fontWeight: 600 }}>{tr("Architecture")}</div>
        <div style={{ fontSize: 52, fontWeight: 700, marginTop: 8 }}>{tr("Ports and adapters around one domain")}</div>
      </div>

      {/* domain */}
      <Box x={835} y={190} w={450} h={640} at={4} tone="domain" bg="rgba(58,75,209,0.10)">
        <Title color={C.accent} size={36}>
          {tr("Domain")}
        </Title>
        <Line>{tr("knows no casino and no database")}</Line>
      </Box>
      <Box x={870} y={300} w={380} h={92} at={16} tone="item">
        <Title size={24}>{tr("Grant policy")}</Title>
        <Line>{tr("deposit → spins")}</Line>
      </Box>
      <Box x={870} y={408} w={380} h={92} at={22} tone="item">
        <Title size={24}>{tr("Wheel")}</Title>
        <Line>{tr("the server picks the prize")}</Line>
      </Box>
      <Box x={870} y={516} w={380} h={290} at={28} tone="item">
        <Title size={24}>{tr("Redemption: an intent")}</Title>
        <Line>{tr("created → reserved")}</Line>
        <Line>{tr("→ submitting")}</Line>
        <Line>{tr("→ issued | refused")}</Line>
        <Line color={C.text} mono>
          one confirm()
        </Line>
        <Line>{tr("the only way to a final status")}</Line>
      </Box>

      {/* ports */}
      <Box x={595} y={300} w={260} h={250} at={46} tone="port">
        <Line color={C.violet} bold>
          {tr("Port")}
        </Line>
        <Title mono size={25} color={C.text}>
          CasinoPlatform
        </Title>
        <div style={{ marginTop: 8 }}>
          <Method name="parseEvents" />
          <Method name="issueReward" lit={hit(3)} />
          <Method name="findReward" />
          <Method name="parseRewardNotice" />
        </div>
      </Box>
      <Box x={1265} y={300} w={260} h={250} at={52} tone="port">
        <Line color={C.violet} bold>
          {tr("Port")}
        </Line>
        <Title mono size={25} color={C.text}>
          CoinLedger
        </Title>
        <div style={{ marginTop: 8 }}>
          <Method name="creditPrize" />
          <Method name="reserve" lit={hit(2)} />
          <Method name="capture" lit={hit(4)} />
          <Method name="release" />
        </div>
      </Box>

      {/* driving side: adapters and the outside */}
      <Box x={290} y={250} w={285} h={150} at={76} tone="adapter">
        <Title size={26} color={C.accent}>
          {tr("Adapter A")}
        </Title>
        <Line>{tr("answers at once,")}</Line>
        <Line>{tr("idempotency key")}</Line>
      </Box>
      <Box x={290} y={420} w={285} h={180} at={82} tone="adapter">
        <Title size={26} color={C.accent}>
          {tr("Adapter B")}
        </Title>
        <Line>{tr("accepts, result")}</Line>
        <Line>{tr("by webhook, no")}</Line>
        <Line>{tr("idempotency key ")}</Line>
      </Box>
      <Box x={290} y={660} w={285} h={130} at={88} tone="adapter">
        <Title size={26} color={C.accent}>
          HTTP API
        </Title>
        <Line>{tr("token, sign-in, roles")}</Line>
      </Box>
      <Box x={20} y={260} w={215} h={110} at={106} tone="outside">
        <Title size={24}>{tr("Casino Alpha")}</Title>
        <Line>{tr("simulated")}</Line>
      </Box>
      <Box x={20} y={455} w={215} h={110} at={112} tone="outside">
        <Title size={24}>{tr("Casino Beta")}</Title>
        <Line>{tr("simulated")}</Line>
      </Box>
      <div style={{ position: "absolute", left: 20, top: 580, width: 230, fontSize: 22, color: C.muted, lineHeight: 1.3, opacity: fadeIn(f, 118) }}>
        {tr("events in; reward request and look-up out")}
      </div>
      <Box x={20} y={670} w={215} h={110} at={118} tone="outside">
        <Title size={24}>{tr("Player page")}</Title>
        <Line>{tr("Back office")}</Line>
      </Box>

      {/* driven side */}
      <Box x={1560} y={300} w={330} h={95} at={124} tone="adapter">
        <Title size={26} color={C.accent}>
          {tr("TigerBeetle adapter")}
        </Title>
      </Box>
      <Box x={1560} y={430} w={330} h={160} at={130} tone="store">
        <Title size={26} color={C.good}>
          TigerBeetle
        </Title>
        <Line>{tr("double-entry ledger")}</Line>
        <Line>pending / post / void</Line>
      </Box>
      <Box x={1560} y={640} w={330} h={150} at={136} tone="store">
        <Title size={26} color={C.good}>
          PostgreSQL
        </Title>
        <Line>{tr("state, outbox (leases),")}</Line>
        <Line>{tr("audit trail")}</Line>
      </Box>
      <Box x={290} y={850} w={995} h={72} at={142} tone="adapter">
        <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
          <div style={{ whiteSpace: "nowrap" }}>
            <Title size={26} color={C.accent}>
              {tr("Outbox → workers")}
            </Title>
          </div>
          <Line>{tr("(scale by count): every call to a casino or the ledger runs as a job")}</Line>
        </div>
      </Box>

      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        <defs>
          <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill={C.muted} />
          </marker>
        </defs>
        {/* casinos <-> adapters */}
        <Arrow d="M 235 315 L 288 315" at={112} both />
        <Arrow d="M 235 510 L 288 510" at={116} both />
        {/* adapters -> CasinoPlatform port */}
        <Arrow d="M 575 325 L 593 325" at={90} />
        <Arrow d="M 575 510 L 593 510" at={92} />
        {/* player page -> HTTP API -> domain */}
        <Arrow d="M 235 725 L 288 725" at={120} />
        <Arrow d="M 575 725 L 833 725" at={94} />
        {/* CoinLedger port -> TigerBeetle adapter -> TigerBeetle */}
        <Arrow d="M 1525 347 L 1558 347" at={126} />
        <Arrow d="M 1725 395 L 1725 428" at={132} />
        {/* domain -> PostgreSQL */}
        <Arrow d="M 1285 715 L 1558 715" at={138} />
        {/* domain -> outbox, outbox -> adapter B (the calls out) */}
        <Arrow d="M 1060 830 L 1060 848" at={144} />
        {p ? <circle cx={p.x} cy={p.y} r={14} fill={C.violet} opacity={0.95} style={{ filter: `drop-shadow(0 0 12px ${C.violet})` }} /> : null}
      </svg>

      <div style={{ position: "absolute", left: 30, right: 30, top: 950, fontSize: 30, lineHeight: 1.3, opacity: fadeIn(f, 160) }}>
        {tr("One domain, one adapter per platform. Both casinos end in the same three outcomes: issued, refused, not known yet.")}
      </div>
    </AbsoluteFill>
  );
};
