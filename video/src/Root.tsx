import { Composition } from "remotion";
import { Demo, DEMO_FRAMES, DEMO_HEIGHT } from "./Demo";
import { Presentation, TOTAL_FRAMES } from "./Presentation";

export const RemotionRoot = () => (
  <>
    <Composition id="Demo" component={Demo} durationInFrames={DEMO_FRAMES} fps={30} width={1920} height={DEMO_HEIGHT} />
    <Composition id="Presentation" component={Presentation} defaultProps={{ lang: "en" as const }} durationInFrames={TOTAL_FRAMES} fps={30} width={1920} height={1080} />
  </>
);
