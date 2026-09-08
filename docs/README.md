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
