import unittest

from analyzer import read_fc_from_bytes


class GpxHeartRateParserTests(unittest.TestCase):
    def test_reads_garmin_trackpoint_extension(self):
        data = b'''<?xml version="1.0"?>
        <gpx xmlns="http://www.topografix.com/GPX/1/1"
             xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
          <trk><trkseg>
            <trkpt lat="39.0" lon="-0.3">
              <time>2026-08-02T08:00:00Z</time>
              <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>121</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
            </trkpt>
            <trkpt lat="39.1" lon="-0.4">
              <time>2026-08-02T08:00:01Z</time>
              <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>123</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
            </trkpt>
          </trkseg></trk>
        </gpx>'''

        series = read_fc_from_bytes(data, "run.gpx")

        self.assertEqual(series.tolist(), [121.0, 123.0])

    def test_repairs_undeclared_exporter_prefix(self):
        data = b'''<?xml version="1.0"?>
        <gpx version="1.1">
          <trk><trkseg>
            <trkpt lat="39.0" lon="-0.3"><time>2026-08-02T08:00:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>87</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
            <trkpt lat="39.1" lon="-0.4"><time>2026-08-02T08:00:02Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>89</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
          </trkseg></trk>
        </gpx>'''

        series = read_fc_from_bytes(data, "realme.gpx")

        self.assertEqual(series.tolist(), [87.0, 89.0])

    def test_reads_gpx_10_and_custom_heart_rate_tag(self):
        data = b'''<?xml version="1.0"?>
        <gpx xmlns="http://www.topografix.com/GPX/1/0" xmlns:pulse="urn:watch:pulse">
          <rte>
            <rtept lat="39.0" lon="-0.3"><time>2026-08-02T08:00:00Z</time><extensions><pulse:heartRate>140</pulse:heartRate></extensions></rtept>
            <rtept lat="39.1" lon="-0.4"><time>2026-08-02T08:00:01Z</time><extensions><pulse:heartRate>142</pulse:heartRate></extensions></rtept>
          </rte>
        </gpx>'''

        series = read_fc_from_bytes(data, "route.gpx")

        self.assertEqual(series.tolist(), [140.0, 142.0])


if __name__ == "__main__":
    unittest.main()
