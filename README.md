# Gaia Galactic Explorer & H–R Engine

A real-data browser laboratory for exploring Gaia DR3 stars as a Hertzsprung–Russell diagram and as a local Galactic point-cloud projection.

**Live demo:** https://biswajit1999.github.io/interactive-hr-diagram-lab/

This build adds:

- browser-safe **10k chunked Gaia loading** for larger modes such as 50k
- multiple H–R diagram colour templates
- textbook-style overlays for main sequence, giants, supergiants and white dwarfs
- Sun marker at BP–RP ≈ 0.82 and M_G ≈ 4.67
- luminosity side axis
- 3D local Galactic projection mode
- PNG export
- live telemetry and technical console

## Why 50k failed before

The old GitHub Pages version tried to download 50k rows as one large CSV through a public CORS bridge. That can trigger HTTP 413 or browser fetch failures. This version requests Gaia rows in pages of 10,000 using `source_id` keyset pagination.

For very large modes such as 250k or 1M, a server-side proxy is still recommended.

## Scientific model

The Gaia query retrieves:

```sql
SELECT TOP N source_id, ra, dec, parallax, bp_rp, phot_g_mean_mag
FROM gaiadr3.gaia_source
WHERE parallax > 2
AND parallax_over_error > 20
AND bp_rp IS NOT NULL
AND phot_g_mean_mag IS NOT NULL
AND source_id > last_source_id
ORDER BY source_id
```

The app computes:

```text
distance_pc = 1000 / parallax_mas
M_G = phot_g_mean_mag + 5 + 5 log10(parallax_mas / 1000)
```

The 3D projection uses:

```text
x = d cos(dec) cos(ra)
y = d cos(dec) sin(ra)
z = d sin(dec)
```

## GitHub Pages structure

Upload these files to the repository root:

```text
index.html
styles.css
gaia-api.js
README.md
LICENSE
.nojekyll
images/
```

Then enable GitHub Pages from:

```text
Settings → Pages → Deploy from a branch → main → /root
```

## Notes

- Start with 10,000 rows.
- Try 50,000 after confirming 10k works.
- If public CORS bridges fail, deploy the Node proxy version for reliability.
- All plotted stars are real Gaia DR3 rows; the app does not generate fake stars.

© 2026 Biswajit Jana. Code may be reused or modified with credit. Gaia catalogue data belongs to the ESA Gaia mission/archive sources.
