"""calculate_metrics must not store 0.0 when a NaN would make pearsonr raise."""
import unittest
import numpy as np
import pandas as pd
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analyzer import calculate_metrics


class CalculateMetricsNanTest(unittest.TestCase):
    def test_leading_nan_does_not_zero_a_real_correlation(self):
        n = 200
        rng = np.random.default_rng(0)
        ref = 140 + 20 * np.linspace(0, 1, n) + rng.normal(0, 1, n)
        dev = ref + 1 + rng.normal(0, 1, n)
        ref[0] = np.nan  # same pattern as Cirqa «Series cortas»: first reference sample missing
        metrics = calculate_metrics(pd.Series(ref), pd.Series(dev))
        self.assertEqual(metrics["n"], n - 1)
        self.assertIsNotNone(metrics["r"])
        self.assertGreater(metrics["r"], 0.9)
        self.assertGreater(metrics["ccc"], 0.9)
        self.assertGreater(metrics["icc"], 0.9)
        self.assertIsNotNone(metrics["slope"])
        self.assertNotEqual(metrics["r"], 0.0)
        self.assertNotEqual(metrics["p"], 1.0)

    def test_undefined_correlation_is_none_not_zero(self):
        metrics = calculate_metrics(pd.Series([120.0]), pd.Series([125.0]))
        self.assertEqual(metrics["n"], 1)
        self.assertIsNone(metrics["r"])
        self.assertIsNone(metrics["p"])
        self.assertIsNone(metrics["slope"])


if __name__ == "__main__":
    unittest.main()
