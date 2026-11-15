# Gaia HR uncertainty and selection diagnostics — 15 November 2026

Three independent calculations: first-order uncertainty in absolute Gaia G magnitude from parallax and apparent G errors (including optional covariance); sensitivity to **assumed**, not calibrated, additive parallax offsets; and retention counts under varying parallax signal-to-noise cuts. Formula: dM_G/d(parallax_mas)=5/[ln(10) parallax_mas].

Run from this directory: `python -m pytest test_gaia_uncertainty.py -q`. Synthetic tests only; no Gaia catalogue was downloaded. No extinction correction, Gaia spatial/colour-dependent zero-point model, sample completeness correction or non-Gaussian low-SNR distance inference is supplied. For actual Gaia DR3 use, document ADQL query and catalogue release, and test quality-cut selection effects.

Prepared with AI coding assistance under the maintainer's direction.
