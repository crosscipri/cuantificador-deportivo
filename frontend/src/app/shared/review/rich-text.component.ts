import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, ViewChild } from '@angular/core';
import type Quill from 'quill';
@Component({selector:'app-review-rich-text',standalone:true,template:`<div #editor class="editor"></div><small>Párrafos, listas, negrita, cursiva y enlaces. Añade los títulos del índice como bloques Título.</small>`,styles:[`.editor{min-height:120px;background:white;color:#18181b}small{color:var(--ink-3)}`]})
export class RichTextComponent implements AfterViewInit,OnChanges,OnDestroy {
  @Input() value='';@Input() disabled=false;@Output() valueChange=new EventEmitter<string>();
  @ViewChild('editor') editor!:ElementRef<HTMLDivElement>;
  private quill?:Quill;private destroyed=false;
  async ngAfterViewInit():Promise<void>{const {default:Editor}=await import('quill');if(this.destroyed)return;
    this.quill=new Editor(this.editor.nativeElement,{theme:'snow',readOnly:this.disabled,formats:['bold','italic','link','list'],modules:{toolbar:[['bold','italic'],[{list:'ordered'},{list:'bullet'}],['link','clean']]}});
    this.quill.clipboard.dangerouslyPasteHTML(this.value,'silent');
    this.quill.on('text-change',(_d,_old,source)=>{if(source==='user'&&!this.disabled){this.value=this.semanticHtml();this.valueChange.emit(this.value);}});
  }
  // Quill exports ordinary spaces as &nbsp;, which prevents natural word wrapping in articles.
  private semanticHtml():string{return this.quill!.getSemanticHTML().replaceAll('&nbsp;', ' ');}
  ngOnChanges():void{if(this.quill){this.quill.enable(!this.disabled);if(this.semanticHtml()!==this.value)this.quill.clipboard.dangerouslyPasteHTML(this.value,'silent');}}
  ngOnDestroy():void{this.destroyed=true;this.quill?.off('text-change');}
}
