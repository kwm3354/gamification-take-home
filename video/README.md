# Presentation film

A silent film of about two minutes, 1920×1080, 30 fps, made with Remotion, and a 25 s GIF for the
top of the README. The slides are drawn in `src/Presentation.tsx`; the GIF (cursor, zoom, rings
drawn over the footage) in `src/Demo.tsx`. The footage is real: screen recordings of the running compose stack,
made by the scripts in `capture/`. The rendered film is `docs/video/presentation.mp4`.

## Capture the footage

The scripts drive the system Chrome through `puppeteer-core` (no browser is downloaded). They
record with the DevTools screencast and turn the frames into 30 fps clips with `ffmpeg`.

1. Start a separate compose project, so a running demo stack is not touched (run from the repo root):

   ```
   APP_PORT=35080 FAKE_PORT=35081 PG_PORT=55329 TB_PORT=35009 JAEGER_PORT=35086 \
     docker compose -p video up -d --build --wait
   ```

2. Capture, in this order (each script expects the state the one before left; the film's trim
   points and captions in `src/Presentation.tsx` were set for one run like this):

   ```
   cd video
   npm install
   node capture/play.mjs alpha     # public/clips/play-alpha.mp4
   node capture/play.mjs beta      # public/clips/play-beta.mp4
   node capture/failure.mjs        # fail-arm, fail-redeem, fail-check
   node capture/admin.mjs          # admin.mp4 and capture/raw/admin-detail.png (the audit still)
   ffmpeg -i capture/raw/admin-detail.png -q:v 2 public/stills/audit.jpg
   ```

   The prizes on the wheel are random, so a new run has different timings. Each clip has a
   `.json` next to it with the time of every step. Use those times to move the trim points and
   captions in `src/Presentation.tsx`.

   `admin.mjs` blurs the new key in the page before it is shown, so no recorded frame holds the
   secret. It replaces the Alpha event signing key of this throwaway stack.

3. Stop the stack: `docker compose -p video down -v`.

Environment: `APP_URL`, `FAKE_URL` (defaults `http://localhost:35080`, `http://localhost:35081`),
`CHROME` (default `/usr/bin/google-chrome`).

## Render

```
npx remotion studio                 # preview
npx remotion render Presentation out/presentation.mp4 --codec=h264 --crf=24
cp out/presentation.mp4 ../docs/video/presentation.mp4

npx remotion render Demo out/demo.mp4 --codec=h264 --crf=14
ffmpeg -i out/demo.mp4 -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 ../docs/video/demo.gif
```

If a render fails with `ERR_NETWORK_CHANGED` while fetching a clip, run it again: Chrome drops
local requests when the host's network interfaces change (for example, when Docker creates a
network).

`remotion.config.ts` points Remotion at the system Chrome.

The clips in `public/clips/` are committed with the project (they are small). `capture/raw/`
(frame dumps and screenshots) and `out/` are ignored.
