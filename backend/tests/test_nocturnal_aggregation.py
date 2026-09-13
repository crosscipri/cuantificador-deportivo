import unittest

from main import _balanced_nocturnal_stats


class NocturnalAggregationTests(unittest.TestCase):
    def test_balances_error_metrics_and_correlation_by_night(self):
        sessions = [
            {"points": [{"x": 1, "y": 2}, {"x": 2, "y": 3}, {"x": 3, "y": 4}]},
            {"points": [{"x": 10, "y": 8}, {"x": 20, "y": 18}, {"x": 30, "y": 28}]},
        ]

        result = _balanced_nocturnal_stats(sessions)

        self.assertEqual(result["n_sessions"], 2)
        self.assertEqual(result["n_correlation_sessions"], 2)
        self.assertEqual(result["pearson_fisher"], 0.9999)
        self.assertEqual(result["mae"], 1.5)
        self.assertEqual(result["rmse"], 1.5)
        self.assertEqual(result["bias"], -0.5)

    def test_returns_none_without_valid_nights(self):
        self.assertIsNone(_balanced_nocturnal_stats([]))


if __name__ == "__main__":
    unittest.main()
