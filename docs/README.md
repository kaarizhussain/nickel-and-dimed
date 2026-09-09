# docs

`dashboard.png` is captured headlessly, so it contains the page and nothing else —
no browser chrome, no tabs, no desktop. Regenerate it after a UI change with the
app running (`npm run api` and `npm run dev`):

    chrome --headless=new --disable-gpu --hide-scrollbars \
           --screenshot=docs/dashboard.png \
           --window-size=1340,1760 --force-device-scale-factor=2 \
           --virtual-time-budget=25000 http://localhost:5173

`--virtual-time-budget` matters: the dashboard fetch and the written summary are
both async, and without it the shot lands on an empty page.

`drawer.gif` is the vendor drill-down, captured the same way — headless, so it
holds the page and nothing else. `capture-drawer-gif.mjs` drives the running app
over the DevTools protocol and writes a frame sequence, then prints the `ffmpeg`
line that encodes it:

    node docs/capture-drawer-gif.mjs

Frames and the throwaway Chrome profile go to the system temp directory on
purpose. Vite watches the project tree, and it exits with `EBUSY` the moment it
tries to watch Chrome's locked profile files; frames written under the project
would also trigger HMR reloads that close the drawer mid-capture.

192 colors with `dither=none` beats dithering here — the UI is flat fills, so
there are no gradients to band, and the palette stays sharp on small text at
1280×720 in about 700 KB.
