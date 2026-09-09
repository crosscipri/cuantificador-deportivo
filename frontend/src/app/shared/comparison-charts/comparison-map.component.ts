import { AfterViewInit, Component, ElementRef, EventEmitter, Input, Output, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import * as L from 'leaflet';
import { ComparisonGpsTrack, GpsPoint, deviceColor } from '../../models/comparison.model';
import { downloadCanvasPng } from '../chart-export';

@Component({selector:'app-comparison-map',standalone:true,
  template:`<div [class.expanded]="fullscreen"><button (click)="expand()">{{fullscreen?'Salir':'Pantalla completa'}}</button><button (click)="exportTracks()">PNG de trayectorias</button><div #map class="map" aria-label="Trayectorias GPS de la comparación"></div></div>`,
  styles:[`.map{height:500px;border:1px solid var(--line);border-radius:var(--r-md)}.expanded{position:fixed;inset:1rem;z-index:1500;background:var(--surface);padding:1rem}.expanded .map{height:85vh}button{padding:.5rem;margin:.4rem;cursor:pointer}`]})
export class ComparisonMapComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() tracks: ComparisonGpsTrack[]=[];
  @Input() hidden: string[]=[];
  @Input() cursorUtc: number | null = null;
  @Input() colorByError=false;
  @Output() cursor=new EventEmitter<number>();
  fullscreen=false;
  @ViewChild('map') container!: ElementRef<HTMLDivElement>;
  private map?: L.Map;
  private layers?: L.LayerGroup;
  private cursors?: L.LayerGroup;
  private pointIndex=new Map<string,Map<number,GpsPoint>>();
  ngAfterViewInit():void {
    this.map=L.map(this.container.nativeElement,{preferCanvas:true}).setView([40,-3],5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(this.map);
    this.layers=L.layerGroup().addTo(this.map);this.cursors=L.layerGroup().addTo(this.map);this.draw();
  }
  ngOnChanges(changes:SimpleChanges):void{if(changes['tracks']||changes['hidden']||changes['colorByError'])this.draw();this.drawCursor();}
  private drawCursor():void {
    if(!this.cursors)return;this.cursors.clearLayers();if(this.cursorUtc==null)return;
    for(const track of this.tracks.filter(t=>!this.hidden.includes(t.id))){
      const point=this.pointIndex.get(track.id)?.get(this.cursorUtc);if(!point)continue;
      const label=document.createElement('span');label.textContent=track.name;
      L.circleMarker([point.lat,point.lon],{radius:7,color:track.role==='reference'?'#18181b':deviceColor(track.device_id||track.id),fillOpacity:1}).bindTooltip(label).addTo(this.cursors);
    }
  }
  private draw():void {
    if(!this.map||!this.layers)return;
    this.pointIndex=new Map(this.tracks.map(track=>[track.id,new Map(track.segments.flat().filter(p=>p.t!=null).map(p=>[p.t!,p]))]));
    this.layers.clearLayers();const bounds=L.latLngBounds([]);
    for(const track of this.tracks.filter(t=>!this.hidden.includes(t.id))){
      const color=track.role==='reference'?'#18181b':deviceColor(track.device_id||track.id);
      for(const segment of track.segments){
        if(!segment.length)continue;
        const points=segment.map(p=>L.latLng(p.lat,p.lon));
        const label=document.createElement('span');label.textContent=track.name;
        const select=(event:L.LeafletMouseEvent)=>{let nearest:GpsPoint|undefined,best=Infinity;for(const point of segment){if(point.t==null)continue;const d=this.map!.distance(event.latlng,[point.lat,point.lon]);if(d<best){best=d;nearest=point;}}if(nearest?.t!=null)this.cursor.emit(nearest.t);};
        if(this.colorByError&&track.role!=='reference'){
          let shade='',run:L.LatLng[]=[];
          const flush=()=>{if(run.length>1)L.polyline(run,{color:shade,weight:3,smoothFactor:0}).on('click',select).addTo(this.layers!);};
          for(let i=1;i<segment.length;i++){
            const error=segment[i].geometry_distance_m;
            const next=error==null?'#a1a1aa':`hsl(${120-Math.min(10,Math.floor(error/5))*12},75%,40%)`;
            if(next!==shade){flush();shade=next;run=[points[i-1]];}run.push(points[i]);
          }flush();
        }else L.polyline(points,{color,weight:track.role==='reference'?4:2.5,smoothFactor:0}).bindTooltip(label).on('click',select).addTo(this.layers);
        L.circleMarker(points[0],{radius:4,color}).addTo(this.layers);
        L.circleMarker(points[points.length-1],{radius:4,color,fillOpacity:0}).addTo(this.layers);
        for(const point of points)bounds.extend(point);
      }
    }
    if(bounds.isValid())this.map.fitBounds(bounds,{padding:[25,25]});
  }
  ngOnDestroy():void{this.map?.remove();}
  expand():void{this.fullscreen=!this.fullscreen;setTimeout(()=>this.map?.invalidateSize(),0);}
  exportTracks():void{
    if(!this.map)return;const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;const ctx=canvas.getContext('2d')!;
    ctx.fillStyle='#fff';ctx.fillRect(0,0,1920,1080);ctx.fillStyle='#18181b';ctx.font='28px sans-serif';ctx.fillText('Trayectorias GPS · proyección cartográfica de la vista',50,50);
    const size=this.map.getSize(),scale=Math.min(1820/size.x,900/size.y),ox=(1920-size.x*scale)/2,oy=100;
    ctx.save();ctx.beginPath();ctx.rect(50,90,1820,920);ctx.clip();
    for(const track of this.tracks.filter(t=>!this.hidden.includes(t.id))){ctx.strokeStyle=track.role==='reference'?'#18181b':deviceColor(track.device_id||track.id);ctx.lineWidth=track.role==='reference'?4:2.5;
      for(const segment of track.segments){ctx.beginPath();segment.forEach((p,i)=>{const at=this.map!.latLngToContainerPoint([p.lat,p.lon]);if(i)ctx.lineTo(ox+at.x*scale,oy+at.y*scale);else ctx.moveTo(ox+at.x*scale,oy+at.y*scale);});ctx.stroke();}}
    ctx.restore();ctx.font='18px sans-serif';let x=50,y=80;
    for(const track of this.tracks.filter(t=>!this.hidden.includes(t.id))){const label=track.name.slice(0,42),width=ctx.measureText(label).width+45;if(x+width>1860){x=50;y+=24;}ctx.fillStyle=track.role==='reference'?'#18181b':deviceColor(track.device_id||track.id);ctx.fillRect(x,y-12,20,4);ctx.fillText(label,x+28,y);x+=width;}
    const bounds=this.map.getBounds();ctx.fillStyle='#18181b';ctx.font='18px sans-serif';ctx.fillText(`Ventana geográfica: ${bounds.getSouth().toFixed(5)}, ${bounds.getWest().toFixed(5)} → ${bounds.getNorth().toFixed(5)}, ${bounds.getEast().toFixed(5)} · consultar fuentes y metodología.`,50,1040);
    downloadCanvasPng(canvas,'trayectorias-1920x1080.png');
  }
}
