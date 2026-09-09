"""Native timestamp/channel inspection, without reinterpreting legacy analyses."""
import io
from datetime import timezone
import fitparse
import numpy as np
import pandas as pd
from analyzer import _parse_gpx_xml,_parse_xml,_xml_local_name
from .statistics import finite

UNITS={'hr':'bpm','power':'W','cadence':'rpm','altitude':'m','distance':'m'}


def read_channels(data,filename):
    records,laps=[],[]
    if filename.lower().endswith('.fit') or data[8:12]==b'.FIT':
        fit=fitparse.FitFile(io.BytesIO(data),check_crc=False)
        for msg in fit.get_messages():
            values=msg.get_values()
            if msg.name=='record':
                stamp=values.get('timestamp')
                if stamp and stamp.tzinfo is None:stamp=stamp.replace(tzinfo=timezone.utc)
                records.append({'t':stamp,'hr':values.get('heart_rate'),'power':values.get('power'),'cadence':values.get('cadence'),
                                'altitude':values.get('enhanced_altitude',values.get('altitude')),'distance':values.get('distance')})
            elif msg.name=='lap':
                laps.append({'start':values.get('start_time'),'end':values.get('timestamp'),'distance_m':values.get('total_distance'),'duration_seconds':values.get('total_elapsed_time')})
    else:
        is_gpx=filename.lower().endswith('.gpx') or b'<gpx' in data[:600].lower()
        root=_parse_gpx_xml(data) if is_gpx else _parse_xml(data)
        for node in root.iter():
            tag=_xml_local_name(node.tag)
            if tag=='lap':
                fields={_xml_local_name(c.tag):c.text for c in node if c.text}
                stamps=[c.text for c in node.iter() if _xml_local_name(c.tag)=='time' and c.text]
                laps.append({'start':node.get('StartTime'),'end':stamps[-1] if stamps else None,'distance_m':fields.get('distancemeters'),'duration_seconds':fields.get('totaltimeseconds')})
            if tag=='record' and node.get('type')=='HKQuantityTypeIdentifierHeartRate':
                records.append({'t':node.get('startDate'),'hr':node.get('value')});continue
            if tag not in ('trackpoint','trkpt','rtept'):continue
            fields={_xml_local_name(c.tag):c.text for c in node.iter() if c.text and c.text.strip()}
            hr=None
            for child in node.iter():
                if _xml_local_name(child.tag) in ('hr','heartrate','heartratebpm','heart_rate_bpm','heart-rate','heart_rate','bpm'):
                    candidates=[child.text]+[c.text for c in child.iter() if _xml_local_name(c.tag) in ('value','bpm')]
                    hr=next((float(v) for v in candidates if finite(v)),None)
                    if hr is not None:break
            records.append({'t':fields.get('time'),'hr':hr,'distance':fields.get('distancemeters'),
                            'altitude':fields.get('altitudemeters',fields.get('ele')),'power':fields.get('watts',fields.get('power')),
                            'cadence':fields.get('cadence',fields.get('cad'))})
    stamps=pd.to_datetime([r['t'] for r in records],utc=True,errors='coerce',format='mixed')
    result=[]
    for row,stamp in zip(records,stamps):
        if pd.isna(stamp):continue
        result.append({'t':stamp.timestamp(),**{k:float(row[k]) if finite(row.get(k)) else None for k in UNITS}})
    result.sort(key=lambda r:r['t'])
    normalized_laps=[]
    for index,lap in enumerate(laps):
        start=pd.to_datetime(lap['start'],utc=True,errors='coerce');end=pd.to_datetime(lap['end'],utc=True,errors='coerce')
        duration=lap.get('duration_seconds')
        normalized_laps.append({'index':index+1,'start_utc':None if pd.isna(start) else start.timestamp(),
                                'end_utc':None if pd.isna(end) else end.timestamp(),
                                'distance_m':float(lap['distance_m']) if finite(lap.get('distance_m')) else None,
                                'duration_seconds':float(duration) if finite(duration) else None})
    deltas=np.diff([r['t'] for r in result]);positive=deltas[deltas>0]
    return {'records':result,'laps':normalized_laps,'native_points':len(result),'units':UNITS,
            'channels':[k for k in UNITS if any(r[k] is not None for r in result)],
            'duplicate_timestamp_count':int(np.sum(deltas==0)),
            'native_median_step_seconds':float(np.median(positive)) if len(positive) else None,
            'timestamp_precision':'floating UTC seconds; native subsecond timestamps retained',
            'processing_version':'native-channel-reader-1'}
