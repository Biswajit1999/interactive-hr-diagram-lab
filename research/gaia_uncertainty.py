"""Conditional Gaia parallax-to-HR uncertainty diagnostics (no catalogue claims)."""
import math

def absolute_g(g, parallax_mas):
    if not (math.isfinite(g) and math.isfinite(parallax_mas) and parallax_mas > 0):
        raise ValueError('finite magnitude and positive parallax required')
    return g + 5 * math.log10(parallax_mas) - 10

def magnitude_sigma(parallax_mas, sigma_parallax_mas, sigma_g=0., correlation=0.):
    """First-order error propagation, including parallax/G covariance."""
    if not (parallax_mas > 0 and sigma_parallax_mas >= 0 and sigma_g >= 0 and abs(correlation) <= 1):
        raise ValueError('invalid uncertainty inputs')
    k = 5 / (math.log(10) * parallax_mas)
    variance = sigma_g**2 + (k * sigma_parallax_mas)**2 + 2 * correlation * sigma_g * k * sigma_parallax_mas
    return math.sqrt(max(0., variance))

def parallax_offset_sensitivity(g, parallax_mas, offsets_mas):
    """Recompute absolute magnitude under explicitly assumed additive parallax offsets."""
    return [(offset, absolute_g(g, parallax_mas - offset)) for offset in offsets_mas]
