import math
import unittest
from gaia_uncertainty import absolute_g, magnitude_sigma, parallax_offset_sensitivity
class GaiaTests(unittest.TestCase):
    def test_ten_pc(self): self.assertAlmostEqual(absolute_g(10,100),10)
    def test_parallax_derivative(self):
        p=10.; h=1e-4
        derivative=(absolute_g(10,p+h)-absolute_g(10,p-h))/(2*h)
        self.assertAlmostEqual(derivative,5/(math.log(10)*p),places=8)
    def test_zero_uncertainty(self): self.assertEqual(magnitude_sigma(10,0,0),0)
    def test_correlated_limit(self): self.assertAlmostEqual(magnitude_sigma(10,1,0.1,1),0.1+5/math.log(10)/10)
    def test_offset(self): self.assertGreater(parallax_offset_sensitivity(10,10,[0,0.1])[1][1],absolute_g(10,10)-0.03)
    def test_invalid(self):
        with self.assertRaises(ValueError): absolute_g(10,-1)
if __name__=='__main__': unittest.main()
