# Gaia DR3 Galactic Explorer & H–R Engine

A real-data browser laboratory for exploring the Gaia DR3 stellar catalogue as both a Hertzsprung–Russell diagram and a local Galactic point-cloud projection.

This version fixes the repeated **Failed to fetch** problem by removing the fragile pure-frontend TAP request path. The browser no longer tries to query ESA Gaia directly from GitHub Pages. Instead, it talks to a small server-side proxy at `/api/gaia`, and the proxy talks to the Gaia TAP service.

---

## Live website

**Website:**  
https://biswajit1999.github.io/interactive-hr-diagram-lab/

> Note: the website interface can load on GitHub Pages, but real Gaia data fetching requires the backend proxy to be deployed and linked in `public/config.js`.

---

## Preview

![Synthetic H–R diagram generated preview](images/synthetic%20hr%20diagram%20generated.png)

---

## Why this proxy is needed

GitHub Pages is a static host. It cannot run backend code, and browser requests to the ESA Gaia TAP server can fail because of CORS, long-running synchronous requests, proxy limits, and large CSV payloads.

The correct architecture is:

```text
Browser HUD
   ↓
Your own /api/gaia proxy
   ↓
ESA Gaia DR3 TAP sync query
   ↓
CSV stream
   ↓
Web Worker parser
   ↓
Float32Array buffers
   ↓
Canvas H–R plot / Galactic map
```

This project uses real Gaia DR3 catalogue rows. It does not generate fake stars.

---

## Features

- Real Gaia DR3 TAP query through a server-side proxy
- Page-by-page loading: 10k, 50k, 100k, 250k, or 1M row targets
- Worker-based CSV parsing so the UI stays responsive
- Float32Array packing for future WebGL/GPU rendering
- 2D H–R diagram view using Gaia BP–RP and absolute G magnitude
- 3D Galactic map projection using RA, Dec, and parallax
- Live telemetry: rows parsed, accepted stars, rejected rows, rows per second, elapsed time, ETA
- Technical console showing the fetch/parsing phases
- Hover inspection of Gaia sample points in the H–R diagram
- Obsidian NASA/SpaceX-style mission-control UI

---

## Scientific model

The Gaia TAP query retrieves:

```sql
SELECT TOP N source_id, ra, dec, parallax, bp_rp, phot_g_mean_mag
FROM gaiadr3.gaia_source
WHERE parallax > 2
  AND parallax_over_error > 20
  AND bp_rp IS NOT NULL
  AND phot_g_mean_mag IS NOT NULL
ORDER BY source_id
```

The browser worker then computes:

```text
distance_pc = 1000 / parallax_mas
M_G = phot_g_mean_mag + 5 + 5 log10(parallax_mas / 1000)
```

For the Galactic map, RA/Dec/parallax are converted to Cartesian coordinates:

```text
x = d cos(dec) cos(ra)
y = d cos(dec) sin(ra)
z = d sin(dec)
```

---

## Run locally

Install Node.js 18 or later.

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

Start with **10,000 rows**. Once that works, try **50,000**. Larger requests depend on your network, browser memory, and the Gaia TAP response time.

---

## GitHub Pages deployment warning

If you upload only the `public/` folder to GitHub Pages, the app can load visually, but real Gaia fetching will fail unless you also deploy the proxy.

For GitHub Pages:

1. Deploy `server.js` to Render, Railway, Fly.io, a university VM, or another Node host.
2. Open `public/config.js`.
3. Set:

```js
window.GAIA_API_BASE = "https://your-deployed-gaia-proxy.example.com";
```

4. Commit the updated `public/` files to GitHub Pages.

For a full-stack deployment, deploy the whole repository to a Node-capable host and leave `window.GAIA_API_BASE = ""`.

---

## File structure

```text
.
├── package.json
├── server.js
├── README.md
├── images/
│   └── synthetic hr diagram generated.png
└── public/
    ├── index.html
    ├── styles.css
    ├── app.js
    ├── gaia-worker.js
    └── config.js
```

---

## Notes on 1,000,000 stars

A million rows is possible, but it should be treated as a heavy mode. The browser stores about 40 bytes per star in typed arrays before any rendering overhead, so one million stars means roughly 40 MB of final packed buffers, plus parsing and canvas/WebGL memory.

For a future production version, the next step should be:

- TAP async jobs for long-running Gaia queries
- server-side caching of completed pages
- binary dataset export instead of CSV on every page load
- WebGL point-cloud renderer with shader-based colour mapping
- progressive `bufferSubData` updates

---

## Credits

Created by **Biswajit Jana** as part of an academic/scientific computing portfolio.

Data source: ESA Gaia DR3 archive.

© 2026 Biswajit Jana. Code may be reused or modified with credit. Scientific data belongs to the original Gaia mission/archive sources.
