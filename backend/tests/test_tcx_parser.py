import unittest

from analyzer import read_fc_from_bytes


class TcxHeartRateParserTests(unittest.TestCase):
    def test_reads_namespaced_garmin_tcx(self):
        data = b'''<?xml version="1.0"?>
        <TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
          <Activities><Activity Sport="Running"><Lap><Track>
            <Trackpoint><Time>2026-08-02T08:00:00Z</Time><HeartRateBpm><Value>121</Value></HeartRateBpm></Trackpoint>
            <Trackpoint><Time>2026-08-02T08:00:01Z</Time><HeartRateBpm><Value>123</Value></HeartRateBpm></Trackpoint>
          </Track></Lap></Activity></Activities>
        </TrainingCenterDatabase>'''

        series = read_fc_from_bytes(data, "garmin.tcx")

        self.assertEqual(series.tolist(), [121.0, 123.0])

    def test_reads_namespace_free_realme_tcx(self):
        data = b'''<?xml version="1.0"?>
        <TrainingCenterDatabase>
          <Activities><Activity Sport=""><Lap><Track>
            <Trackpoint><Time>2026-07-13T16:03:13.000Z</Time><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>77</Value></HeartRateBpm></Trackpoint>
          </Track><Track>
            <Trackpoint><Time>2026-07-13T16:03:18.000Z</Time><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>79</Value></HeartRateBpm></Trackpoint>
          </Track></Lap></Activity></Activities>
        </TrainingCenterDatabase>'''

        series = read_fc_from_bytes(data, "realme.tcx")

        self.assertEqual(series.tolist(), [77.0, 79.0])

    def test_reads_tcx_10_with_direct_heart_rate(self):
        data = b'''<?xml version="1.0"?>
        <TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v1">
          <Activities><Activity><Lap><Track>
            <Trackpoint><Time>2026-08-02T08:00:00Z</Time><HeartRate>140</HeartRate></Trackpoint>
            <Trackpoint><Time>2026-08-02T08:00:01Z</Time><HeartRate>142</HeartRate></Trackpoint>
          </Track></Lap></Activity></Activities>
        </TrainingCenterDatabase>'''

        series = read_fc_from_bytes(data, "legacy.tcx")

        self.assertEqual(series.tolist(), [140.0, 142.0])


if __name__ == "__main__":
    unittest.main()
