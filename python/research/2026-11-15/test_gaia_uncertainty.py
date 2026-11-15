import numpy as np
import pytest
from gaia_uncertainty import absolute_g_with_uncertainty,parallax_zero_point_sensitivity,parallax_snr_selection

def test_ten_parsecs():
    m,s=absolute_g_with_uncertainty(100.,12.,1.)
    assert m==pytest.approx(12.)
    assert s==pytest.approx(5/np.log(10)/100)

def test_uncertainty_quadrature():
    _,s=absolute_g_with_uncertainty(10.,15.,.1,.02)
    assert s**2==pytest.approx(.02**2+(5/np.log(10)*.01)**2)

def test_assumed_offset_monotonic():
    m=parallax_zero_point_sensitivity([2.,10.],[15.,12.],[-.02,0,.02])
    assert m.shape==(3,2)
    assert np.all(np.diff(m,axis=0)>0)

def test_nested_snr_cuts():
    assert parallax_snr_selection([1,2,3,4],[.2]*4,[5,10,20]).tolist()==[4,3,1]

def test_invalid_offset():
    with pytest.raises(ValueError): parallax_zero_point_sensitivity([.01],[12],[-.02])
