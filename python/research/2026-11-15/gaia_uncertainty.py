"""Gaia HR first-order measurement and selection sensitivity diagnostics."""
import numpy as np

def absolute_g_with_uncertainty(parallax_mas,g_mag,parallax_error_mas,g_error_mag=0.,covariance=0.):
    """Propagate parallax and G magnitude errors, covariance in mas*mag."""
    p,g,sp,sg,c=np.broadcast_arrays(*[np.asarray(x,dtype=float) for x in (parallax_mas,g_mag,parallax_error_mas,g_error_mag,covariance)])
    if not all(np.all(np.isfinite(x)) for x in (p,g,sp,sg,c)) or np.any(p<=0) or np.any(sp<0) or np.any(sg<0):
        raise ValueError("finite positive parallaxes and nonnegative errors required")
    derivative=5/(np.log(10)*p)
    variance=sg**2+(derivative*sp)**2+2*derivative*c
    if np.any(variance < -1e-12):
        raise ValueError("inconsistent covariance")
    return g+5+5*np.log10(p/1000),np.sqrt(np.maximum(variance,0))

def parallax_zero_point_sensitivity(parallax_mas,g_mag,offsets_mas):
    """Absolute magnitudes for assumed additive parallax corrections."""
    p=np.asarray(parallax_mas,dtype=float)
    offsets=np.asarray(offsets_mas,dtype=float)
    if p.ndim!=1 or offsets.ndim!=1 or not len(p) or not len(offsets):
        raise ValueError("nonempty one-dimensional arrays required")
    corrected=p[None,:]+offsets[:,None]
    if not np.all(np.isfinite(corrected)) or np.any(corrected<=0):
        raise ValueError("corrected parallaxes must be positive and finite")
    g=np.broadcast_to(np.asarray(g_mag,dtype=float),p.shape)
    if not np.all(np.isfinite(g)):
        raise ValueError("finite magnitudes required")
    return g[None,:]+5+5*np.log10(corrected/1000)

def parallax_snr_selection(parallax_mas,parallax_error_mas,thresholds=(5,10,20)):
    """Counts above parallax S/N thresholds; not a completeness correction."""
    p,s=np.broadcast_arrays(np.asarray(parallax_mas,dtype=float),np.asarray(parallax_error_mas,dtype=float))
    if p.ndim!=1 or np.any(s<=0) or not np.all(np.isfinite(p)) or not np.all(np.isfinite(s)):
        raise ValueError("finite one-dimensional parallaxes and positive errors required")
    t=np.asarray(thresholds,dtype=float)
    if t.ndim!=1 or not np.all(np.isfinite(t)) or np.any(t<=0):
        raise ValueError("positive finite thresholds required")
    return np.array([np.count_nonzero((p>0)&(p/s>=v)) for v in t],dtype=int)
