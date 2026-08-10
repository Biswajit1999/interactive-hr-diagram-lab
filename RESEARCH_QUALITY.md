# Research Quality Upgrade

This repository has been upgraded with a compact research-quality layer: reference anchors, validation checks, and explicit scientific/software boundaries.

## Scope

Gaia-style Hertzsprung-Russell diagram lab for colour-magnitude structure, stellar populations and evolution tracks.

## Equations And Models

- Absolute magnitude M = m - 5 log10(d/10 pc)
- Luminosity-temperature-radius scaling L = 4 pi R^2 sigma T^4

## Reference Anchors

The file `data/research-reference.json` stores benchmark anchors used by `scripts/validate_repository.mjs`. These are intentionally small and auditable so the repository can be checked without network access.

## Browser Upgrade

If this repository contains a browser interface, `research-overlay.js` adds a non-invasive mission-control quality panel with validation status and benchmark telemetry.

## References

- Gaia Collaboration, 2023. Gaia Data Release 3: Summary of the content and survey properties. Astronomy & Astrophysics, 674, A1.
