import type { Conversation, ConversationSummary } from '../shared/types.js';

type Layout = 'rings' | 'circle' | 'hex' | 'grid';
type Grouping = 'months' | 'all';
type Theme = 'gold' | 'ocean' | 'violet';
type BrainSettings = { layout: Layout; grouping: Grouping; theme: Theme; speed: number; size: number; labels: boolean };
type Point = { item: ConversationSummary; x: number; y: number; radius: number; color: string };
const defaults: BrainSettings = { layout:'rings', grouping:'months', theme:'gold', speed:20, size:100, labels:true };
const palettes: Record<Theme, string[]> = { gold:['#d9bd7e','#e7d8a3','#b49b67','#f0cb8c','#a68b60'], ocean:['#45d0c4','#80bff1','#75e0b3','#8998e8','#aecfe7'], violet:['#bf9ceb','#edbad0','#a2baf1','#dab1e5','#dfc597'] };
function el<T extends HTMLElement>(id: string): T { const node = document.getElementById(id); if (!node) throw Error(`Missing ${id}`); return node as T; }
function settings(): BrainSettings {
  const value = {...defaults};
  try {
    const saved = JSON.parse(localStorage.getItem('kagemiyura-brain-v1') ?? '{}') as Partial<BrainSettings>;
    if (saved.layout && ['rings','circle','hex','grid'].includes(saved.layout)) value.layout = saved.layout;
    if (saved.grouping && ['months','all'].includes(saved.grouping)) value.grouping = saved.grouping;
    if (saved.theme && ['gold','ocean','violet'].includes(saved.theme)) value.theme = saved.theme;
    if (typeof saved.speed === 'number' && Number.isFinite(saved.speed)) value.speed = Math.max(0, Math.min(100, saved.speed));
    if (typeof saved.size === 'number' && Number.isFinite(saved.size)) value.size = Math.max(70, Math.min(150, saved.size));
    if (typeof saved.labels === 'boolean') value.labels = saved.labels;
  } catch { /* storage may be unavailable */ }
  return value;
}
export function createBrain(openConversation: (id: string) => Promise<void>) {
  const canvas = el<HTMLCanvasElement>('brain-canvas'); const context = canvas.getContext('2d');
  if (!context) throw Error('Canvas недоступен');
  const ctx: CanvasRenderingContext2D = context;
  const stage = canvas.parentElement!; const search = el<HTMLInputElement>('brain-search');
  const speed = el<HTMLInputElement>('brain-speed'); const size = el<HTMLInputElement>('brain-size'); const labels = el<HTMLInputElement>('brain-labels');
  const dialog = el<HTMLDialogElement>('brain-details');
  let config = settings(); let items: ConversationSummary[] = []; let points: Point[] = []; let hasMore = false; let requestId = 0; let detailId = 0;
  let width = 1; let height = 1; let scale = 1; let offsetX = 0; let offsetY = 0; let phase = 0; let last = 0; let frame = 0; let visible = false;
  let selected: ConversationSummary | undefined; let drag: { x:number; y:number; startX:number; startY:number; moved:boolean } | undefined;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const color = (index: number) => palettes[config.theme][index % 5]!;
  function syncControls() {
    speed.value = String(config.speed); size.value = String(config.size); labels.checked = config.labels;
    el('brain-speed-value').textContent = `${config.speed}%`; el('brain-size-value').textContent = `${config.size}%`;
    document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach(b=>{ const on=b.dataset.layout===config.layout; b.classList.toggle('active',on); b.setAttribute('aria-pressed',String(on)); });
    document.querySelectorAll<HTMLButtonElement>('[data-group]').forEach(b=>{ const on=b.dataset.group===config.grouping; b.classList.toggle('active',on); b.setAttribute('aria-pressed',String(on)); });
    document.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach(b=>{ const on=b.dataset.theme===config.theme; b.classList.toggle('active',on); b.setAttribute('aria-pressed',String(on)); });
  }
  function save() {
    try { localStorage.setItem('kagemiyura-brain-v1', JSON.stringify(config)); el('brain-status').textContent='Настройки карты сохранены.'; }
    catch { el('brain-status').textContent='Не удалось сохранить настройки в браузере.'; }
  }
  function resize() {
    const rect = stage.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    width = rect.width; height = rect.height; const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; ctx.setTransform(ratio,0,0,ratio,0,0);
    if (visible) draw();
  }
  function monthKey(item: ConversationSummary) {
    const d = new Date(item.updatedAt); return Number.isNaN(d.getTime()) ? 'Без даты' : d.toLocaleString('ru-RU',{month:'long',year:'numeric'});
  }
  function groups() {
    const result = new Map<string, ConversationSummary[]>();
    for (const item of items) { const key=config.grouping==='all'?'Разговоры':monthKey(item); const list=result.get(key) ?? []; list.push(item); result.set(key,list); }
    return [...result.entries()];
  }
  function draw() {
    if (!visible || width < 2) return;
    ctx.clearRect(0,0,width,height); ctx.fillStyle='#071019'; ctx.fillRect(0,0,width,height);
    ctx.save(); ctx.translate(width/2+offsetX,height/2+offsetY); ctx.scale(scale,scale);
    const base = Math.max(120, Math.min(width,height)*0.30); const palette=palettes[config.theme]; const grouped=groups(); points=[];
    const stroke=(radius:number, alpha:number) => {ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.strokeStyle=`rgba(164,186,183,${alpha})`;ctx.lineWidth=0.8;ctx.stroke();};
    for (let i=0;i<4;i++) stroke(base*(0.32+i*0.25),0.10);
    // Decorative stars are background only, not data or inferred relationships.
    for(let i=0;i<90;i++){ const x=((i*137)%997)/997*width-width/2;const y=((i*293)%991)/991*height-height/2;ctx.fillStyle='rgba(170,191,194,.12)';ctx.fillRect(x,y,i%9===0?2:1,i%9===0?2:1); }
    const total=Math.max(items.length,1); let index=0;
    grouped.forEach(([group, list], groupIndex)=>{
      const groupAngle=(groupIndex/Math.max(grouped.length,1))*Math.PI*2-Math.PI/2 + phase;
      list.forEach((item, i)=>{
        let x=0,y=0; const angle=groupAngle+(i-(list.length-1)/2)*Math.min(.19,2.8/Math.max(list.length,1));
        if(config.layout==='rings') {const ring=base*(0.68+Math.floor(i/14)*0.24);x=Math.cos(angle)*ring;y=Math.sin(angle)*ring;}
        else if(config.layout==='circle') {const a=index/total*Math.PI*2-Math.PI/2+phase;x=Math.cos(a)*base;y=Math.sin(a)*base;}
        else if(config.layout==='grid') {const cols=Math.ceil(Math.sqrt(total)); const spacing=Math.min(95,base*1.6/Math.max(cols-1,1)); x=(index%cols-(cols-1)/2)*spacing;y=(Math.floor(index/cols)-(Math.ceil(total/cols)-1)/2)*spacing;}
        else {const cols=Math.ceil(Math.sqrt(total));const spacing=Math.min(100,base*1.6/Math.max(cols-1,1));const row=Math.floor(index/cols);x=(index%cols-(cols-1)/2+(row%2)*.5)*spacing;y=(row-(Math.ceil(total/cols)-1)/2)*spacing*.87;}
        index++; const radius=Math.max(5,Math.min(12,(5+Math.log2(item.messageCount+1))*config.size/100)); const c=color(groupIndex); points.push({item,x,y,radius,color:c});
        if(config.layout==='rings'||config.layout==='circle'){ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(x,y);ctx.strokeStyle='rgba(140,170,175,.10)';ctx.lineWidth=.7;ctx.stroke();}
        if(config.layout==='hex'){ctx.beginPath();for(let j=0;j<6;j++){const a=Math.PI/3*j;const px=x+Math.cos(a)*radius*2.1,py=y+Math.sin(a)*radius*2.1;j===0?ctx.moveTo(px,py):ctx.lineTo(px,py);}ctx.closePath();ctx.strokeStyle=c+'55';ctx.stroke();}
        ctx.beginPath();ctx.arc(x,y,radius*1.8,0,Math.PI*2);ctx.strokeStyle=c+'55';ctx.lineWidth=1;ctx.stroke();
        ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fillStyle=c;ctx.shadowColor=c;ctx.shadowBlur=8;ctx.fill();ctx.shadowBlur=0;
        if(config.labels && total<=70){ctx.font='10px Segoe UI, sans-serif';ctx.fillStyle='#c6c9c7';ctx.textAlign='center';ctx.fillText(item.title.length>24?item.title.slice(0,23)+'…':item.title,x,y+radius+15);}
      });
      if(config.grouping==='months' && list.length && config.layout==='rings') {const a=groupAngle;ctx.font='11px Segoe UI, sans-serif';ctx.fillStyle=color(groupIndex);ctx.textAlign='center';ctx.fillText(group.toLocaleUpperCase('ru-RU'),Math.cos(a)*base*1.34,Math.sin(a)*base*1.34);}
    });
    if(config.layout==='rings'||config.layout==='circle'||items.length===0){ctx.beginPath();ctx.arc(0,0,25,0,Math.PI*2);ctx.fillStyle='#071019';ctx.fill();ctx.strokeStyle=palette[0]!;ctx.lineWidth=1.3;ctx.stroke();
    ctx.font='italic 23px Georgia, serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=palette[0]!;ctx.fillText('К',0,1);ctx.textBaseline='alphabetic';}
    ctx.restore();
  }
  function animate(time:number) { if(!visible) return; if(!last || time-last>=33){if(last && !reducedMotion.matches && config.speed>0){phase += Math.min(time-last,100)*config.speed/100*0.00008;draw();} last=time;} frame=requestAnimationFrame(animate); }
  function list() {
    const box=el('brain-list'); box.replaceChildren();
    for(const item of items) {const b=document.createElement('button');b.textContent=item.title;b.title=item.title;b.addEventListener('click',()=>{void showDetails(item);});box.append(b);}
    el('brain-count').textContent=`${items.length} ${hasMore?'показано':'разговоров'}`;
    el('brain-more').hidden=!hasMore; if(!items.length) el('brain-status').textContent=search.value.trim()?'Ничего не найдено.':'Здесь появятся сохранённые разговоры.'; else el('brain-status').textContent='';
  }
  async function load(more=false) {
    const id=++requestId;const offset=more?items.length:0;el('brain-status').textContent='Загружаю карту…';
    try {
      const response=await fetch(`/api/conversations?q=${encodeURIComponent(search.value.trim())}&offset=${offset}`);
      if(!response.ok) throw Error('Не удалось загрузить разговоры.');
      const data=await response.json() as { conversations: ConversationSummary[]; hasMore:boolean };if(id!==requestId)return;
      items=more?[...items,...data.conversations]:data.conversations;hasMore=data.hasMore;list();draw();
    } catch { if(id===requestId) el('brain-status').textContent='Не удалось загрузить карту. Нажми «Обновить».'; }
  }
  async function showDetails(item:ConversationSummary) {
    selected=item;const id=++detailId;el('brain-details-title').textContent=item.title;
    el('brain-details-meta').textContent=`Сообщений: ${item.messageCount} · Обновлён: ${new Date(item.updatedAt).toLocaleString('ru-RU')}`;
    el('brain-details-preview').textContent='Загрузка…';if(!dialog.open)dialog.showModal();
    try {const response=await fetch(`/api/conversations/${item.id}`);if(!response.ok)throw Error();const c=await response.json() as Conversation;
      if(id===detailId && dialog.open) el('brain-details-preview').textContent=c.messages.slice(0,2).map(m=>`${m.role==='user'?'Ты':'Кагэмиюра'}: ${m.content}`).join('\n\n').slice(0,600) || 'В этом разговоре пока нет сообщений.';
    } catch {if(id===detailId && dialog.open)el('brain-details-preview').textContent='Не удалось загрузить разговор.';}
  }
  canvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;drag={x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false};canvas.setPointerCapture(event.pointerId);});
  canvas.addEventListener('pointermove',event=>{if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>4)drag.moved=true;offsetX+=dx;offsetY+=dy;drag.x=event.clientX;drag.y=event.clientY;draw();});
  canvas.addEventListener('pointerup',event=>{if(!drag)return;if(!drag.moved){const rect=canvas.getBoundingClientRect();const x=(event.clientX-rect.left-width/2-offsetX)/scale,y=(event.clientY-rect.top-height/2-offsetY)/scale;const hit=[...points].reverse().find(p=>Math.hypot(p.x-x,p.y-y)<Math.max(p.radius*2,12/scale));if(hit)void showDetails(hit.item);}drag=undefined;});
  canvas.addEventListener('pointercancel',()=>{drag=undefined;});
  canvas.addEventListener('wheel',event=>{event.preventDefault();scale=Math.max(.4,Math.min(3,scale*(event.deltaY<0?1.12:.89)));draw();},{passive:false});
  el('brain-plus').addEventListener('click',()=>{scale=Math.min(3,scale*1.2);draw();});el('brain-minus').addEventListener('click',()=>{scale=Math.max(.4,scale/1.2);draw();});
  el('brain-center').addEventListener('click',()=>{scale=1;offsetX=0;offsetY=0;draw();});
  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach(b=>b.addEventListener('click',()=>{config.layout=b.dataset.layout as Layout;syncControls();draw();}));
  document.querySelectorAll<HTMLButtonElement>('[data-group]').forEach(b=>b.addEventListener('click',()=>{config.grouping=b.dataset.group as Grouping;syncControls();draw();}));
  document.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach(b=>b.addEventListener('click',()=>{config.theme=b.dataset.theme as Theme;syncControls();draw();}));
  speed.addEventListener('input',()=>{config.speed=Number(speed.value);syncControls();});size.addEventListener('input',()=>{config.size=Number(size.value);syncControls();draw();});
  labels.addEventListener('change',()=>{config.labels=labels.checked;draw();});
  let timer:ReturnType<typeof setTimeout>;search.addEventListener('input',()=>{++requestId;clearTimeout(timer);timer=setTimeout(()=>{void load();},250);});
  el('brain-refresh').addEventListener('click',()=>{void load();});el('brain-more').addEventListener('click',()=>{void load(true);});el('brain-save').addEventListener('click',save);
  el('brain-export').addEventListener('click',()=>{const link=document.createElement('a');link.download='kagemiyura-memory.png';link.href=canvas.toDataURL('image/png');link.click();});
  el('brain-details-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  el('brain-open-chat').addEventListener('click',()=>{if(!selected)return;const id=selected.id;dialog.close();void openConversation(id).catch(()=>{el('brain-status').textContent='Не удалось открыть разговор. Попробуй ещё раз.';});});
  window.addEventListener('resize',()=>{if(visible)resize();});syncControls();
  return {setVisible(value:boolean){if(value===visible)return;visible=value;if(value){resize();void load();last=0;frame=requestAnimationFrame(animate);}else{cancelAnimationFrame(frame);last=0;}}};
}
