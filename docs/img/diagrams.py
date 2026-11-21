#!/usr/bin/env python3
"""Writes the two architecture diagrams as SVG. Standard library only.

Usage: python3 docs/img/diagrams.py docs/img
Output: service.svg (the service and what is outside it), redemption.svg (the life of a redemption).
"""
import os
import sys
from xml.sax.saxutils import escape

INK = "#16191f"
MUTED = "#4f5866"
LINE = "#9aa3af"
PAPER = "#ffffff"
# Three accents: ours (blue), outside or simulated (amber), stores (green).
BLUE, BLUE_BG = "#1f4fbf", "#eef3fd"
AMBER, AMBER_BG = "#9a5200", "#fdf3e1"
GREEN, GREEN_BG = "#17734a", "#e8f6ee"
SANS = "Helvetica, Arial, sans-serif"


def text_width(s, size, bold=False):
    """A rough width in pixels, good enough to size boxes and label backgrounds."""
    w = 0.0
    for c in s:
        if c in "ilI.,:;|'!()[]/":
            w += 0.30
        elif c in " ftjr-":
            w += 0.36
        elif c in "mwMW":
            w += 0.88
        elif c.isupper() or c.isdigit():
            w += 0.66
        else:
            w += 0.55
    return w * size * (1.08 if bold else 1.0)


class Svg:
    def __init__(self, w, h, title):
        self.w, self.h, self.parts = w, h, []
        self.title = title

    def text(self, x, y, s, size=13, weight=400, fill=INK, anchor="start", italic=False):
        style = ' font-style="italic"' if italic else ""
        self.parts.append(
            f'<text x="{x:.1f}" y="{y:.1f}" font-family="{SANS}" font-size="{size}" '
            f'font-weight="{weight}" fill="{fill}" text-anchor="{anchor}"{style}>{escape(s)}</text>'
        )

    def lines(self, x, y, rows, size=12, fill=INK, weight=400, anchor="start", gap=None):
        gap = gap or size * 1.35
        for i, row in enumerate(rows):
            self.text(x, y + i * gap, row, size, weight, fill, anchor)
        return y + len(rows) * gap

    def box(self, x, y, w, h, fill=PAPER, stroke=LINE, r=8, sw=1.2, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{r}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>'
        )

    def card(self, x, y, w, h, title, rows, color, bg, dash=None, size=12):
        self.box(x, y, w, h, bg, color, dash=dash)
        self.text(x + 10, y + 19, title, 13, 700, color)
        self.lines(x + 10, y + 37, rows, size, INK)

    def arrow(self, pts, color=MUTED, dash=None, both=False):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        start = ' marker-start="url(#tail)"' if both else ""
        path = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts)
        self.parts.append(
            f'<path d="{path}" fill="none" stroke="{color}" stroke-width="1.6" '
            f'stroke-linejoin="round"{d} marker-end="url(#head)"{start}/>'
        )

    def label(self, x, y, s, fill=MUTED, size=12, anchor="middle", weight=600):
        """Text on a white patch, so a line under it never runs through the letters."""
        w = text_width(s, size, weight >= 600) + 8
        left = {"middle": x - w / 2, "start": x - 4, "end": x - w + 4}[anchor]
        self.parts.append(
            f'<rect x="{left:.1f}" y="{y - size:.1f}" width="{w:.1f}" height="{size + 5}" rx="3" fill="{PAPER}"/>'
        )
        self.text(x, y, s, size, weight, fill, anchor)

    def badge(self, x, y, n):
        self.parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="10" fill="{AMBER}"/>')
        self.text(x, y + 4.5, str(n), 12, 700, PAPER, "middle")

    def render(self):
        defs = (
            "<defs>"
            f'<marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M0 0 L10 5 L0 10 z" fill="{MUTED}"/></marker>'
            f'<marker id="tail" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M0 0 L10 5 L0 10 z" fill="{MUTED}"/></marker>'
            "</defs>"
        )
        bg = f'<rect x="0" y="0" width="{self.w}" height="{self.h}" rx="14" fill="{PAPER}"/>'
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" '
            f'viewBox="0 0 {self.w} {self.h}" role="img" aria-label="{escape(self.title)}">'
            f"<title>{escape(self.title)}</title>{defs}{bg}" + "".join(self.parts) + "</svg>\n"
        )


def service():
    d = Svg(1060, 760, "The service and what is outside it")
    d.text(24, 34, "The service and what is outside it", 18, 700)
    d.text(24, 56, "Blue: our code. Amber: outside parties (simulated in the prototype). Green: the two stores.", 12, 400, MUTED)

    # Outside, left column.
    d.card(24, 86, 220, 82, "Player", ["the casino's page with our widget", "token signed by the operator"], AMBER, AMBER_BG)
    d.card(24, 196, 220, 82, "Operator staff, our ops", ["back office after sign-in", "token we sign, three roles"], AMBER, AMBER_BG)

    d.box(24, 316, 220, 300, AMBER_BG, AMBER, dash="6 4")
    d.text(36, 338, "Fake casino process", 13, 700, AMBER)
    d.text(36, 355, "simulated, separate process", 12, 400, MUTED)
    d.card(36, 368, 196, 96, "Platform A", ["answers a reward at once", "honours Idempotency-Key", "signs events with a timestamp"], AMBER, PAPER)
    d.card(36, 476, 196, 96, "Platform B", ["accepts, reports by webhook", "no idempotency key", "sends deposits in batches"], AMBER, PAPER)
    d.text(36, 598, "faults on demand, control page", 12, 400, MUTED)

    # Our application.
    ax, ay, aw, ah = 340, 86, 404, 600
    d.box(ax, ay, aw, ah, BLUE_BG, BLUE, sw=1.6)
    d.text(ax + 14, ay + 22, "Our application: one NestJS process, a module per folder", 13, 700, BLUE)

    lx, rx, cw, ch = ax + 12, ax + 204, 188, 92
    rows_y = [ay + 40, ay + 150, ay + 260, ay + 370, ay + 480]
    left = [
        ("Tenants and identity", ["tenants, players (id mapping)", "player token guard", "src/tenants"]),
        ("Admin and alerts", ["audit trail, stuck list", "manual resolve, 7 alerts", "src/admin, src/alerts"]),
        ("Wheel", ["spins, pickSegment", "outcome: secret + spin id", "src/wheel"]),
        ("Integrations", ["port CasinoPlatform", "adapter A, adapter B", "src/integrations"]),
        ("Store", ["redemption intent", "advance, confirm", "src/store"]),
    ]
    right = [
        ("Event intake", ["signature, dedup by key", "grant policy (versioned)", "src/events, src/policies"]),
        ("Outbox", ["jobs in PostgreSQL", "timer every 500 ms", "src/outbox"]),
        ("Audit", ["one write path", "same transaction", "src/audit"]),
        ("Ledger adapter", ["port CoinLedger", "fixed transfer ids", "src/ledger"]),
        ("Logging", ["one JSON line per event", "request id, level by policy", "src/logging"]),
    ]
    for (title, rows), y in zip(left, rows_y):
        d.card(lx, y, cw, ch, title, rows, BLUE, PAPER)
    for (title, rows), y in zip(right, rows_y):
        d.card(rx, y, cw, ch, title, rows, BLUE, PAPER)

    # Stores, right column.
    sx = 862
    d.card(sx, 160, 174, 150, "PostgreSQL", ["tenants, players, events", "spins, redemptions", "policies (versioned)", "outbox jobs", "audit log (append-only)"], GREEN, GREEN_BG)
    d.card(sx, 420, 174, 128, "TigerBeetle", ["coins only", "one ledger per tenant", "pending, post, void", "no negative balance"], GREEN, GREEN_BG)
    d.box(sx, 600, 174, 86, PAPER, LINE, dash="5 4")
    d.text(sx + 10, 620, "Daily digest agent", 13, 700, MUTED)
    d.lines(sx + 10, 638, ["reads logs and database", "designed, not built"], 12, MUTED)

    # Player -> tenants row; operator -> admin row. Straight lines.
    d.arrow([(244, 150), (lx, 150)])
    d.label(292, 141, "HTTPS + JWT")
    d.arrow([(244, 262), (lx, 262)])
    d.label(284, 253, "sign-in token")
    # Fake casino <-> integrations row.
    yi = rows_y[3]
    d.arrow([(244, yi + 22), (lx, yi + 22)])
    d.label(296, yi + 13, "signed events")
    d.arrow([(lx, yi + 52), (244, yi + 52)])
    d.label(296, yi + 43, "issue, look up")
    d.arrow([(244, yi + 82), (lx, yi + 82)], dash="5 3")
    d.label(296, yi + 73, "B: result")

    # App -> PostgreSQL.
    mid = (ax + aw + sx) / 2
    d.arrow([(ax + aw, 236), (sx, 236)])
    d.label(mid, 226, "one transaction:")
    d.label(mid, 256, "row, audit, job")
    # App -> TigerBeetle.
    yt = rows_y[3] + 46
    d.arrow([(ax + aw, yt), (sx, yt)])
    d.label(mid, yt - 10, "transfers with")
    d.label(mid, yt + 20, "ids from our ids")
    # Logs -> digest.
    yl = rows_y[4] + 56
    d.arrow([(ax + aw, yl), (sx, yl)], dash="5 3")
    d.label(mid, yl - 10, "JSON lines")

    d.text(24, 724, "No transaction spans the two stores. Order: PostgreSQL commit (with the job), then TigerBeetle with a fixed id, then mark done.", 12, 400, MUTED)
    d.text(24, 744, "A crash in between is repaired by the outbox job running the same step again.", 12, 400, MUTED)
    return d.render()


def redemption():
    d = Svg(1000, 700, "The life of a redemption")
    d.text(24, 34, "The life of a redemption", 18, 700)
    d.text(24, 56, "Boxes are statuses in the redemptions table. Each arrow says who moves it. Amber numbers are failure points.", 12, 400, MUTED)

    H = 56
    my = 170  # main row
    boxes = {
        "created": (24, my, 130),
        "reserved": (234, my, 130),
        "submitting": (474, my, 150),
        "issued": (724, 96, 106),
        "refused": (724, 266, 106),
        "insufficient": (24, 330, 130),
    }

    def state(name, sub):
        x, y, w = boxes[name]
        final = name in ("issued", "refused", "insufficient")
        d.box(x, y, w, H, PAPER if not final else BLUE_BG, BLUE, sw=1.6 if final else 1.2)
        d.text(x + w / 2, y + 24, name, 14, 700, BLUE, "middle")
        d.text(x + w / 2, y + 42, sub, 12, 400, MUTED, "middle")

    state("created", "intent + job")
    state("reserved", "coins held")
    state("submitting", "asking the casino")
    state("issued", "final for player")
    state("refused", "final for player")
    state("insufficient", "final, no call")

    for y, label in ((96, "captured"), (266, "released")):
        d.box(900, y, 86, H, GREEN_BG, GREEN)
        d.text(943, y + 24, "settled", 14, 700, GREEN, "middle")
        d.text(943, y + 42, label, 12, 400, MUTED, "middle")

    # Entry.
    d.arrow([(89, 96), (89, my)])
    d.label(89, 88, "player: POST /store/redemptions + Idempotency-Key", anchor="start")
    # created -> reserved
    d.arrow([(154, my + 28), (234, my + 28)])
    d.label(194, my + 18, "job: reserve")
    d.badge(194, my + 46, 1)
    # created -> insufficient
    d.arrow([(89, my + H), (89, 330)])
    d.label(98, 300, "ledger refuses the reserve", anchor="start")
    # reserved -> submitting
    d.arrow([(364, my + 28), (474, my + 28)])
    d.label(419, my + 18, "job: commit first")
    # submitting -> issued / refused
    d.arrow([(624, my + 14), (672, my + 14), (672, 124), (724, 124)])
    d.label(666, 112, "confirm()", anchor="end")
    d.arrow([(624, my + 42), (672, my + 42), (672, 294), (724, 294)])
    d.label(666, 314, "confirm()", anchor="end")
    d.badge(646, my - 6, 2)
    # self loop under submitting
    d.arrow([(520, my + H), (520, my + 96), (578, my + 96), (578, my + H)])
    d.label(549, my + 116, "pending or no answer: look again later")
    d.badge(598, my + 78, 3)
    # settle
    d.arrow([(830, 124), (900, 124)])
    d.label(865, 114, "capture")
    d.arrow([(830, 294), (900, 294)])
    d.label(865, 284, "release")
    d.badge(865, 152, 4)
    d.badge(588, 350, 5)

    # Who calls confirm.
    d.box(234, 330, 380, 118, BLUE_BG, BLUE)
    d.text(246, 352, "confirm() is the only way to a final status", 13, 700, BLUE)
    d.lines(246, 372, [
        "Called from: platform A's answer, the status look-up",
        "(both in the job step), platform B's webhook, an admin.",
        "Acts only on submitting, under the row lock; any later",
        "call changes nothing.",
    ], 12)
    d.box(644, 400, 342, 48, PAPER, LINE, dash="5 4")
    d.lines(656, 420, ["Rule for the casino: look first, then issue.", "Rule for the ledger: repeat freely, the id is fixed."], 12, MUTED)

    # Failure legend.
    d.text(24, 486, "Failure points (rows and tests in docs/failure-table.md)", 13, 700)
    rows = [
        "Crash between the ledger reserve and the status write: the job repeats the reserve with the same id.",
        "Answer lost, timeout, 500 or 429: never refused; status stays submitting and the next run looks first.",
        "Platform B's callback lost or sent twice: the look-up finds the result; a second notice changes nothing.",
        "Ledger away while settling: shows issued, settled false; the job captures later, once.",
        "No answer at all: alert on age, then an admin resolves through confirm(); a late answer that disagrees",
    ]
    y = 512
    for i, r in enumerate(rows, start=1):
        d.badge(36, y - 4, i)
        d.text(56, y, r, 12)
        y += 26
    d.text(56, y - 8, "is written as outcome_contradicted.", 12)
    d.text(24, 680, "Not drawn: revoking a reward after it was issued (not built).", 12, 400, MUTED)
    return d.render()


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    for name, make in (("service.svg", service), ("redemption.svg", redemption)):
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            f.write(make())
        print(os.path.join(out, name))


if __name__ == "__main__":
    main()
