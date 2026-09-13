import unittest

from comparisons.archive import display_track_segments


class ArchiveTrackDisplayTests(unittest.TestCase):
    def test_reduces_map_payload_and_preserves_endpoints(self):
        segment = [{"lat": index, "lon": index} for index in range(5000)]

        result = display_track_segments([segment], max_points=1000)

        self.assertLessEqual(len(result[0]), 1001)
        self.assertIs(result[0][0], segment[0])
        self.assertIs(result[0][-1], segment[-1])

    def test_keeps_small_tracks_unchanged(self):
        segments = [[{"lat": 1, "lon": 2}, {"lat": 2, "lon": 3}]]
        self.assertIs(display_track_segments(segments), segments)


if __name__ == "__main__":
    unittest.main()
