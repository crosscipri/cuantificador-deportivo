"""Nearest point on spherical minor arcs; no timestamp matching implied."""
import numpy as np
from scipy.spatial import cKDTree

RADIUS = 6371000.0


def vector(point):
    lat,lon=np.radians([point["lat"],point["lon"]])
    return np.array([np.cos(lat)*np.cos(lon),np.cos(lat)*np.sin(lon),np.sin(lat)])


def angle(a,b):
    return np.arctan2(np.linalg.norm(np.cross(a,b),axis=-1),np.clip(np.sum(a*b,axis=-1),-1,1))


class ReferencePath:
    def __init__(self,segments):
        starts,ends,progress=[],[],[]
        elapsed=0.0
        self.progress_by_time={}
        for segment in segments:
            for first,last in zip(segment,segment[1:]):
                a,b=vector(first),vector(last)
                length=float(angle(a,b))*RADIUS
                if first.get("t") is not None:self.progress_by_time[first["t"]]=elapsed
                if length>0.001 and length<np.pi*RADIUS-1:
                    starts.append(a);ends.append(b);progress.append(elapsed)
                elapsed+=length
                if last.get("t") is not None:self.progress_by_time[last["t"]]=elapsed
        self.a=np.asarray(starts);self.b=np.asarray(ends);self.progress=np.asarray(progress)
        self.available=bool(starts)
        if not self.available:return
        self.arc=angle(self.a,self.b)
        self.normals=np.cross(self.a,self.b);self.normals/=np.linalg.norm(self.normals,axis=1)[:,None]
        self.centers=self.a+self.b;self.centers/=np.linalg.norm(self.centers,axis=1)[:,None]
        self.tree=cKDTree(self.centers)
        self.max_half=float(self.arc.max()/2)*RADIUS

    def project(self,point):
        if not self.available:return None
        p=vector(point)
        _,initial=self.tree.query(p,k=min(8,len(self.a)))
        ids=np.atleast_1d(initial)
        def candidates(indices):
            a,b,n=self.a[indices],self.b[indices],self.normals[indices]
            projected=p-n*np.sum(n*p,axis=1)[:,None]
            norms=np.linalg.norm(projected,axis=1)
            q=projected/np.maximum(norms,1e-15)[:,None]
            along=np.arctan2(np.sum(q*np.cross(n,a),axis=1),np.sum(q*a,axis=1))
            interior=(norms>1e-12)&(along>=0)&(along<=self.arc[indices])
            da,db=angle(a,p),angle(b,p)
            distance=np.where(interior,angle(q,p),np.minimum(da,db))*RADIUS
            offset=np.where(interior,along,np.where(da<=db,0,self.arc[indices]))*RADIUS
            return distance,self.progress[indices]+offset
        d,_=candidates(ids)
        # Spherical triangle inequality bounds every possible closer segment.
        radius=2*np.sin(min(np.pi,(float(d.min())+self.max_half+3)/RADIUS)/2)
        ids=np.asarray(self.tree.query_ball_point(p,radius),dtype=int)
        distances,progress=candidates(ids)
        best=int(np.argmin(distances))
        ambiguous=bool(np.any((np.abs(ids-ids[best])>1)&(distances<=distances[best]+3)))
        return {"distance_m":float(distances[best]),"progress_m":float(progress[best]),"ambiguous":ambiguous}


def compare_geometry(reference_segments,points):
    if sum(len(s) for s in reference_segments)>100000 or len(points)>100000:
        return {"geometry_reason":"La geometría supera el límite de 100.000 puntos; acota la ventana."}
    path=ReferencePath(reference_segments)
    distances,along=[],[]
    ambiguous=0
    continuous_reference=sum(bool(segment) for segment in reference_segments)==1
    for point in points:
        result=path.project(point)
        if result is None:continue
        point["geometry_distance_m"]=result["distance_m"]
        distances.append(result["distance_m"])
        ambiguous+=int(result["ambiguous"])
        if continuous_reference and not result["ambiguous"] and point.get("t") in path.progress_by_time:
            along.append(result["progress_m"]-path.progress_by_time[point["t"]])
    return {"cross_track_mean_m":float(np.mean(distances)) if distances else None,
            "cross_track_p95_m":float(np.percentile(distances,95)) if distances else None,
            "cross_track_max_m":max(distances) if distances else None,"geometry_n":len(distances),
            "along_track_bias_m":float(np.mean(along)) if along else None,
            "along_track_mae_m":float(np.mean(np.abs(along))) if along else None,
            "along_track_n":len(along),"ambiguous_projection_n":ambiguous,
            "geometry_method":"nearest_spherical_minor_arc_v1","geometry_reason":None if distances else "No hay segmentos de referencia calculables."}
