import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import * as L from 'leaflet';
import { ComparisonGpsTrack, GpsPoint, deviceColor } from '../../models/comparison.model';

interface UrbanView {id:string;name:string;deviceId:string;color:string;visible:boolean;segments:GpsPoint[][];mean:number;p95:number;max:number;samples:number;}
@Component({selector:'app-comparison-gps-urban-view',standalone:true,imports:[CommonModule],templateUrl:'./comparison-gps-urban-view.component.html',styleUrls:['../gps-urban-analysis/gps-urban-analysis.component.scss','./comparison-gps-specialized.component.scss']})
export class ComparisonGpsUrbanViewComponent implements AfterViewInit,OnChanges,OnDestroy{
  @Input() tracks:ComparisonGpsTrack[]=[];@ViewChild('map') container!:ElementRef<HTMLDivElement>;
  views:UrbanView[]=[];references:ComparisonGpsTrack[]=[];selectedId='';private map?:L.Map;private layers?:L.LayerGroup;
  readonly chartW=780;readonly chartH=145;
  ngAfterViewInit():void{this.map=L.map(this.container.nativeElement,{preferCanvas:true,zoomSnap:.5,zoomDelta:.5}).setView([40,-3],5);L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{subdomains:'abcd',attribution:'© OpenStreetMap © CARTO',maxZoom:20}).addTo(this.map);this.layers=L.layerGroup().addTo(this.map);this.draw();}
  ngOnChanges(_:SimpleChanges):void{this.references=this.tracks.filter(t=>t.role==='reference');this.views=this.tracks.filter(t=>t.role!=='reference').map(t=>this.view(t));this.selectedId=this.views[0]?.id||'';this.draw();}
  ngOnDestroy():void{this.map?.remove();}
  get selected():UrbanView|undefined{return this.views.find(v=>v.id===this.selectedId)||this.views[0];}
  toggle(view:UrbanView):void{view.visible=!view.visible;if(view.visible)this.selectedId=view.id;this.draw();}
  select(view:UrbanView):void{this.selectedId=view.id;this.draw();}
  fit():void{this.fitAll();}
  fmt(v:number,d=2):string{return Number.isFinite(v)?v.toLocaleString('es-ES',{maximumFractionDigits:d}):'—';}
  profile(view:UrbanView):string{const pts=view.segments.flat().filter(p=>p.geometry_distance_m!=null),max=Math.max(10,...pts.map(p=>p.geometry_distance_m||0));return pts.map((p,i)=>`${i?'L':'M'}${(35+i/Math.max(1,pts.length-1)*(this.chartW-50)).toFixed(1)},${(10+(1-(p.geometry_distance_m||0)/max)*(this.chartH-35)).toFixed(1)}`).join(' ');}
  private view(track:ComparisonGpsTrack):UrbanView{const values=track.segments.flat().map(p=>p.geometry_distance_m).filter((v):v is number=>v!=null&&Number.isFinite(v)).sort((a,b)=>a-b);return{id:track.id,name:track.name,deviceId:track.device_id||track.id,color:deviceColor(track.device_id||track.id),visible:true,segments:track.segments,mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:NaN,p95:values[Math.min(values.length-1,Math.floor(values.length*.95))]??NaN,max:values.at(-1)??NaN,samples:track.segments.flat().length};}
  private draw():void{if(!this.map||!this.layers)return;this.layers.clearLayers();const bounds=L.latLngBounds([]);
    for(const ref of this.references)for(const segment of ref.segments){const ll=segment.map(p=>[p.lat,p.lon] as L.LatLngTuple);if(ll.length<2)continue;L.polyline(ll,{color:'#1a1a1a',weight:5,opacity:.85}).addTo(this.layers);L.polyline(ll,{color:'#fff',weight:2.5,opacity:.95,dashArray:'8 4'}).addTo(this.layers);ll.forEach(p=>bounds.extend(p));}
    for(const view of this.views.filter(v=>v.visible))for(const segment of view.segments){const ll=segment.map(p=>[p.lat,p.lon] as L.LatLngTuple);if(ll.length<2)continue;const selected=view.id===this.selectedId;L.polyline(ll,{color:view.color,weight:selected?4:2.5,opacity:selected?1:.7,smoothFactor:1.2}).bindTooltip(view.name).on('click',()=>this.select(view)).addTo(this.layers);ll.forEach(p=>bounds.extend(p));}
    if(bounds.isValid())setTimeout(()=>this.map?.fitBounds(bounds,{padding:[24,24]}),0);
  }
  private fitAll():void{this.draw();}
}
