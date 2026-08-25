import unittest
from unittest.mock import patch

import pandas as pd

from analyzer import analyze_interval


class IntervalAnalysisTests(unittest.TestCase):
    def setUp(self):
        index = range(1_700_000_000, 1_700_000_020)
        self.reference = pd.Series(range(120, 140), index=index, dtype=float)
        self.device = pd.Series(range(121, 141), index=index, dtype=float)

    @patch("analyzer.read_fc_from_bytes")
    def test_crops_original_data_and_rebases_chart_timeline(self, read_fc):
        read_fc.side_effect = [self.reference, self.device]

        result = analyze_interval(b"device", b"reference", 5, 14)

        self.assertEqual(result["duration_seconds"], 10)
        self.assertEqual(result["source_duration_seconds"], 20)
        self.assertEqual(result["metrics"]["n"], 10)
        self.assertEqual(result["fc_data"]["time"], list(range(10)))
        self.assertEqual(result["fc_data"]["reference"], list(range(125, 135)))
        self.assertEqual(result["fc_data"]["device"], list(range(126, 136)))

    @patch("analyzer.generate_validation_chart", return_value="validation-chart")
    @patch("analyzer.generate_temporal_chart", return_value="temporal-chart")
    @patch("analyzer.read_fc_from_bytes")
    def test_generates_persistable_charts(
        self, read_fc, _temporal_chart, _validation_chart
    ):
        read_fc.side_effect = [self.reference, self.device]

        result = analyze_interval(
            b"device", b"reference", 0, 10, include_charts=True
        )

        self.assertEqual(result["charts"]["temporal"], "temporal-chart")
        self.assertEqual(result["charts"]["validation"], "validation-chart")

    @patch("analyzer.read_fc_from_bytes")
    def test_rejects_bounds_outside_original_activity(self, read_fc):
        read_fc.side_effect = [self.reference, self.device]

        with self.assertRaisesRegex(ValueError, "duración original"):
            analyze_interval(b"device", b"reference", 5, 21)


if __name__ == "__main__":
    unittest.main()
