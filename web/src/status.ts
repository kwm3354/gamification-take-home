export type StatusTone = "wait" | "good" | "bad" | "neutral";

export interface PlayerStatus {
  text: string;
  tone: StatusTone;
  final: boolean;
}

/** What the player reads for a redemption status. The reason stays in "behind the scenes". */
export function playerStatus(status: string): PlayerStatus {
  switch (status) {
    case "created":
    case "reserved":
    case "submitting":
      return { text: "On its way", tone: "wait", final: false };
    case "issued":
      return { text: "In your casino account", tone: "good", final: true };
    case "refused":
      return { text: "Not available, your coins are back", tone: "bad", final: true };
    case "insufficient":
      return { text: "Not enough coins", tone: "neutral", final: true };
    default:
      return { text: "Checking", tone: "wait", final: false };
  }
}
