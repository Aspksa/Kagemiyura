import type { Conversation, ConversationSummary } from '../shared/types.js';

type Layout = 'rings' | 'circle' | 'hex' | 'grid' | 'force' | 'hud';
type Grouping = 'months' | 'all';
type Theme = 'gold' | 'ocean' | 'violet';
type BrainSettings = { layout: Layout; grouping: Grouping; theme: Theme; speed: number; size: number; labels: boolean };
type Point = { item: ConversationSummary; x: number; y: number; radius: number; color: string };
const defaults: BrainSettings = { layout:'rings', grouping:'months', theme:'ocean', speed:20, size:100, labels:true };
const palettes: Record<Theme, string[]> = { gold:['#d9bd7e','#e7d8a3','#b49b67','#f0cb8c','#a68b60'], ocean:['#45d0c4','#80bff1','#75e0b3','#8998e8','#aecfe7'], violet:['#bf9ceb','#edbad0','#a2baf1','#dab1e5','#dfc597'] };
function el<T extends HTMLElement>(id: string): T { const node = document.getElementById(id); if (!node) throw Error(`Missing ${id}`); return node as T; }
function settings(): BrainSettings {
  const value = {...defaults};
  try {
    const saved = JSON.parse(localStorage.getItem('kagemiyura-brain-v1') ?? '{}') as Partial<BrainSettings>;
    if (saved.layout && ['rings','circle','hex','grid','force','hud'].includes(saved.layout)) value.layout = saved.layout;
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
  let view: 'command'|'map' = 'command'; let clock: ReturnType<typeof setInterval> | undefined;
  let forceKey = ''; let forcePoints: {x:number;y:number}[] = [];
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
  function updateClock() { const now=new Date();el('command-time').textContent=now.toLocaleTimeString('ru-RU');el('command-date').textContent=now.toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long',year:'numeric'}); }
  function setView(next:'command'|'map') {
    view=next;el('brain-page').dataset.view=view;el('brain-view-title').textContent=view==='command'?'Команда':'Второй мозг';
    el('brain-command-view').setAttribute('aria-pressed',String(view==='command'));el('brain-map-view').setAttribute('aria-pressed',String(view==='map'));
    if(view==='command' && search.value.trim()){search.value='';void load();}
    requestAnimationFrame(()=>{if(visible)resize();});
  }
  function resize() {
    const rect = stage.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if(canvas.width===Math.round(rect.width*ratio) && canvas.height===Math.round(rect.height*ratio)) return;
    width = rect.width; height = rect.height;
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
  function forceLayout(total:number, base:number) {
    const key=`${items.map(item=>item.id).join(',')}:${Math.round(base)}`;if(key===forceKey)return forcePoints;
    forceKey=key;forcePoints=Array.from({length:total},(_,i)=>{const a=i*2.39996,r=Math.sqrt((i+1)/total)*base*.72;return {x:Math.cos(a)*r,y:Math.sin(a)*r};});
    // A bounded, local repulsion layout; proximity is not a semantic relation.
    if(total<=150)for(let iteration=0;iteration<35;iteration++)for(let i=0;i<total;i++){
      const p=forcePoints[i]!;let fx=-p.x*.002,fy=-p.y*.002;
      for(let j=i+1;j<total;j++){const q=forcePoints[j]!,dx=p.x-q.x,dy=p.y-q.y,d2=Math.max(dx*dx+dy*dy,100);if(d2>10000)continue;const push=65/d2;fx+=dx*push;fy+=dy*push;q.x-=dx*push;q.y-=dy*push;}
      p.x+=Math.max(-4,Math.min(4,fx));p.y+=Math.max(-4,Math.min(4,fy));
    }
    return forcePoints;
  }
  function draw() {
    if (!visible || width < 2) return;
    ctx.clearRect(0,0,width,height); ctx.fillStyle='#020d19'; ctx.fillRect(0,0,width,height);
    ctx.save(); ctx.translate(width/2+offsetX,height/2+offsetY); ctx.scale(scale,scale);
    const base = Math.max(100, Math.min(width,height)*(view==='command'?.34:.43)); const palette=palettes[config.theme]; const grouped=groups(); points=[];
    const stroke=(radius:number, alpha:number) => {ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.strokeStyle=`rgba(164,186,183,${alpha})`;ctx.lineWidth=0.8;ctx.stroke();};
    if(view==='command'||config.layout==='rings'||config.layout==='circle')for (const ring of [.22,.27,.83,.89,.95,.98]) stroke(base*ring,0.10);
    // Decorative stars are background only, not data or inferred relationships.
    for(let i=0;i<90;i++){ const x=((i*137)%997)/997*width-width/2;const y=((i*293)%991)/991*height-height/2;const twinkle=.08+(Math.sin(i*2.3+phase*5)+1)*.045;ctx.fillStyle=`rgba(170,191,194,${twinkle})`;ctx.fillRect(x,y,i%9===0?2:1,i%9===0?2:1); }
    const total=Math.max(items.length,1); let index=0;
    const clusterCount=Math.max(grouped.length,1);
    const clusterCenters=grouped.map((_,i)=>{
      const a=i/clusterCount*Math.PI*2-Math.PI/2;
      const orbit=clusterCount===1?0:base*.57;
      return {x:Math.cos(a)*orbit,y:Math.sin(a)*orbit};
    });
    if(view==='map' && config.layout==='circle'){
      grouped.forEach(([name,list],i)=>{
        const center=clusterCenters[i]!;
        const radius=Math.min(base*.31,Math.max(25,base*.11+Math.sqrt(list.length)*8));
        ctx.beginPath();ctx.arc(center.x,center.y,radius,0,Math.PI*2);
        ctx.fillStyle=color(i)+'0b';ctx.fill();ctx.strokeStyle=color(i)+'55';ctx.lineWidth=1;ctx.stroke();
        ctx.beginPath();ctx.arc(center.x,center.y,radius*.78,0,Math.PI*2);ctx.strokeStyle=color(i)+'22';ctx.stroke();
        ctx.font='10px Consolas, monospace';ctx.fillStyle=color(i);ctx.textAlign='center';
        ctx.fillText(name.toLocaleUpperCase('ru-RU').slice(0,22),center.x,center.y-radius-9);
      });
    }
    grouped.forEach(([group, list], groupIndex)=>{
      list.forEach((item,localIndex)=>{
        let x=0,y=0;
        if(config.layout==='hex' && view==='map'){
          const cols=Math.max(1,Math.ceil(Math.sqrt(total)));const rows=Math.ceil(total/cols);const row=Math.floor(index/cols);
          const tile=Math.min(145,Math.max(22,base/(cols*.9+.4)))*config.size/100;const step=tile*1.65;
          x=(index%cols-(cols-1)/2+(row%2)*.48)*step;y=(row-(rows-1)/2)*step*.86;
          const c=color(groupIndex);ctx.beginPath();for(let j=0;j<6;j++){const a=Math.PI/3*j-Math.PI/6,px=x+Math.cos(a)*tile,py=y+Math.sin(a)*tile;j===0?ctx.moveTo(px,py):ctx.lineTo(px,py);}ctx.closePath();ctx.fillStyle=c+'0b';ctx.fill();ctx.strokeStyle=c+'55';ctx.lineWidth=.8;ctx.stroke();
          ctx.beginPath();ctx.arc(x,y,tile*.22,0,Math.PI*2);ctx.strokeStyle=c+'66';ctx.stroke();
          ctx.beginPath();ctx.arc(x,y,tile*.34,0,Math.PI*2);ctx.strokeStyle=c+'28';ctx.stroke();
          for(let edge=0;edge<6;edge++){const a=Math.PI/3*edge-Math.PI/6;ctx.beginPath();ctx.moveTo(x+Math.cos(a)*tile*.74,y+Math.sin(a)*tile*.74);ctx.lineTo(x+Math.cos(a)*tile*.88,y+Math.sin(a)*tile*.88);ctx.strokeStyle=c+'aa';ctx.lineWidth=1.3;ctx.stroke();}
          const dots=Math.min(item.messageCount,48);for(let k=0;k<dots;k++){const a=k*2.39996,rad=Math.sqrt((k+1)/49)*tile*.72;ctx.fillStyle=c+(k%4===0?'cc':'66');ctx.fillRect(x+Math.cos(a)*rad,y+Math.sin(a)*rad,2,2);}
          ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fillStyle=c;ctx.shadowColor=c;ctx.shadowBlur=12;ctx.fill();ctx.shadowBlur=0;
          if(config.labels){ctx.font='bold 9px Consolas, monospace';ctx.fillStyle=c;ctx.textAlign='center';ctx.fillText(item.title.length>22?item.title.slice(0,21)+'…':item.title,x,y-tile*.45,Math.max(20,tile*1.45));}
          points.push({item,x,y,radius:tile*.48,color:c});index++;return;
        }
        if(config.layout==='rings' || view==='command') {
          const a=index/total*Math.PI*2-Math.PI/2+phase;
          const outer=base*(.76+(index%4)*.064); x=Math.cos(a)*outer; y=Math.sin(a)*outer;
          const mid=base*.47; const innerX=Math.cos(a)*mid,innerY=Math.sin(a)*mid; const c=color(groupIndex);
          ctx.beginPath();ctx.moveTo(innerX,innerY);ctx.lineTo(x,y);ctx.strokeStyle=c+'25';ctx.lineWidth=.65;ctx.stroke();
          const dots=Math.min(item.messageCount,48);
          for(let k=0;k<dots;k++) {const row=Math.floor(k/6),col=k%6;const radius=base*(.32+row*.023);const delta=(col-2.5)*Math.min(.018,1.4/total);const px=Math.cos(a+delta)*radius,py=Math.sin(a+delta)*radius;
            ctx.fillStyle=c+(k%7===0?'cc':'66');ctx.fillRect(px-1.1,py-1.1,2.2,2.2);
          }
          const innerRadius=Math.max(3,Math.min(7,config.size/100*4));
          ctx.beginPath();ctx.arc(innerX,innerY,innerRadius,0,Math.PI*2);ctx.fillStyle=c;ctx.fill();
          ctx.beginPath();ctx.arc(innerX,innerY,innerRadius+4,0,Math.PI*2);ctx.strokeStyle=c+'66';ctx.stroke();
          points.push({item,x:innerX,y:innerY,radius:innerRadius+3,color:c});
          if(config.labels && total<=60){ctx.font='bold 9px Consolas, monospace';ctx.fillStyle=c;ctx.textAlign=Math.cos(a)<-.25?'right':Math.cos(a)>.25?'left':'center';ctx.fillText(item.title.length>20?item.title.slice(0,19)+'…':item.title,Math.cos(a)*base*.64,Math.sin(a)*base*.64);}
        }
        else if(config.layout==='circle') {const center=clusterCenters[groupIndex]!;const a=localIndex/Math.max(list.length,1)*Math.PI*2-Math.PI/2+phase;const radius=Math.min(base*.27,Math.max(19,base*.09+Math.sqrt(list.length)*8));x=center.x+Math.cos(a)*radius*.78;y=center.y+Math.sin(a)*radius*.78;}
        else if(config.layout==='force') {const p=forceLayout(total,base)[index]!;x=p.x;y=p.y;}
        else if(config.layout==='grid'||config.layout==='hud') {const cols=Math.ceil(Math.sqrt(total)); const spacing=Math.min(95,base*1.6/Math.max(cols-1,1)); x=(index%cols-(cols-1)/2)*spacing;y=(Math.floor(index/cols)-(Math.ceil(total/cols)-1)/2)*spacing;}
        else {const cols=Math.ceil(Math.sqrt(total));const spacing=Math.min(100,base*1.6/Math.max(cols-1,1));const row=Math.floor(index/cols);x=(index%cols-(cols-1)/2+(row%2)*.5)*spacing;y=(row-(Math.ceil(total/cols)-1)/2)*spacing*.87;}
        index++; const radius=Math.max(5,Math.min(12,(5+Math.log2(item.messageCount+1))*config.size/100)); const c=color(groupIndex); points.push({item,x,y,radius,color:c});
        if(config.layout==='hud' && view==='map'){ctx.strokeStyle=c+'55';ctx.lineWidth=.8;ctx.strokeRect(x-radius*2.4,y-radius*2.4,radius*4.8,radius*4.8);ctx.strokeStyle=c+'aa';ctx.beginPath();ctx.moveTo(x-radius*2.4,y-radius*1.5);ctx.lineTo(x-radius*2.4,y-radius*2.4);ctx.lineTo(x-radius*1.5,y-radius*2.4);ctx.stroke();}
        if(config.layout==='circle' && view==='map'){ctx.beginPath();ctx.moveTo(clusterCenters[groupIndex]!.x,clusterCenters[groupIndex]!.y);ctx.lineTo(x,y);ctx.strokeStyle='rgba(140,170,175,.20)';ctx.lineWidth=.7;ctx.stroke();}
        if(config.layout==='hex' && view==='map'){ctx.beginPath();for(let j=0;j<6;j++){const a=Math.PI/3*j;const px=x+Math.cos(a)*radius*2.1,py=y+Math.sin(a)*radius*2.1;j===0?ctx.moveTo(px,py):ctx.lineTo(px,py);}ctx.closePath();ctx.strokeStyle=c+'55';ctx.stroke();}
        ctx.beginPath();ctx.arc(x,y,radius*1.45,0,Math.PI*2);ctx.strokeStyle=c+'aa';ctx.lineWidth=.8;ctx.fillStyle='#04111b';ctx.fill();ctx.stroke();
        if(config.layout==='rings'||view==='command'){ctx.strokeStyle=c;ctx.lineWidth=.8;ctx.strokeRect(x-3,y-2.5,6,4.5);ctx.beginPath();ctx.moveTo(x-1,y+2);ctx.lineTo(x-2,y+4);ctx.stroke();}
        else {ctx.beginPath();ctx.arc(x,y,radius*.7,0,Math.PI*2);ctx.fillStyle=c;ctx.shadowColor=c;ctx.shadowBlur=8;ctx.fill();ctx.shadowBlur=0;
          ctx.beginPath();ctx.arc(x,y,radius*2.1,0,Math.PI*2);ctx.strokeStyle=c+'22';ctx.lineWidth=.7;ctx.stroke();}
        if(config.labels && total<=70 && config.layout!=='rings' && view==='map'){ctx.font='10px Consolas, monospace';ctx.fillStyle='#c6c9c7';ctx.textAlign='center';ctx.fillText(item.title.length>24?item.title.slice(0,23)+'…':item.title,x,y+radius+15);}
      });
      if(config.grouping==='months' && list.length && config.layout==='rings' && grouped.length<=24) {const start=index-list.length;const a=(start+(list.length-1)/2)/total*Math.PI*2-Math.PI/2+phase;ctx.font='9px Consolas, monospace';ctx.fillStyle=color(groupIndex);ctx.textAlign='center';ctx.fillText(group.toLocaleUpperCase('ru-RU'),Math.cos(a)*base*.76,Math.sin(a)*base*.76);}
    });
    if(view==='map' && config.layout==='circle' && clusterCount>1){
      ctx.save();ctx.globalAlpha=.24;ctx.strokeStyle=palette[0]!;ctx.lineWidth=.65;
      for(const center of clusterCenters){ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(center.x,center.y);ctx.stroke();}
      ctx.restore();
    }
    if(view==='command') {
      // Decorative central light, not an indication of stored facts.
      for(let n=0;n<160;n++){const a=n*2.39996;const r=Math.sqrt(n/160)*25;const x=Math.cos(a)*r,y=Math.sin(a)*r;ctx.fillStyle=n%5===0?'#65efd2aa':'#4bc7b077';ctx.fillRect(x,y,n%11===0?2:1,n%11===0?2:1);}
    } else if(config.layout==='rings'||config.layout==='circle'||items.length===0){ctx.beginPath();ctx.arc(0,0,29,0,Math.PI*2);ctx.fillStyle='#020a11';ctx.fill();ctx.strokeStyle=palette[0]!;ctx.lineWidth=1.3;ctx.stroke();
    ctx.beginPath();ctx.arc(0,0,34,0,Math.PI*2);ctx.strokeStyle=palette[0]+'44';ctx.lineWidth=1;ctx.stroke();
    ctx.font='italic 23px Georgia, serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=palette[0]!;ctx.fillText('К',0,1);ctx.textBaseline='alphabetic';ctx.font='9px Consolas, monospace';ctx.fillStyle='#91a7a8';ctx.fillText('КАГЭМИЮРА',0,51);}
    ctx.restore();
  }
  function animate(time:number) { if(!visible) return; if(!last || time-last>=33){if(last && !reducedMotion.matches && config.speed>0){phase += Math.min(time-last,100)*config.speed/100*0.00008;draw();} last=time;} frame=requestAnimationFrame(animate); }
  function list() {
    const box=el('brain-list'); box.replaceChildren();
    for(const item of items) {const b=document.createElement('button');b.textContent=item.title;b.title=item.title;b.addEventListener('click',()=>{void showDetails(item);});box.append(b);}
    const left=el('command-list');const recent=el('command-recent');left.replaceChildren();recent.replaceChildren();
    for (const [index,item] of items.entries()) {
      const button=document.createElement('button');button.className='command-row';
      const dot=document.createElement('i');dot.style.backgroundColor=color(index);
      const title=document.createElement('span');title.textContent=item.title;
      const count=document.createElement('small');count.textContent=String(item.messageCount);
      button.append(dot,title,count);button.addEventListener('click',()=>{void showDetails(item);});left.append(button);
      if(index<6){const recentButton=button.cloneNode(true) as HTMLButtonElement;recentButton.addEventListener('click',()=>{void showDetails(item);});recent.append(recentButton);}
    }
    el('command-count').textContent=String(items.length);el('command-total').textContent=String(items.length);
    el('command-empty').hidden=items.length>0;el('command-load-more').hidden=!hasMore;
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
  canvas.addEventListener('pointermove',event=>{
    const tip=el('brain-tooltip');
    if(!drag){const rect=canvas.getBoundingClientRect();const px=event.clientX-rect.left,py=event.clientY-rect.top;const x=(px-width/2-offsetX)/scale,y=(py-height/2-offsetY)/scale;const hit=[...points].reverse().find(p=>Math.hypot(p.x-x,p.y-y)<Math.max(p.radius*2,12/scale));tip.hidden=!hit;if(hit){tip.textContent=`${hit.item.title} · Сообщений: ${hit.item.messageCount}`;tip.style.left=`${Math.max(8,Math.min(width-210,px+14))}px`;tip.style.top=`${Math.max(8,Math.min(height-55,py+14))}px`;}return;}
    tip.hidden=true;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>4)drag.moved=true;offsetX+=dx;offsetY+=dy;drag.x=event.clientX;drag.y=event.clientY;draw();
  });
  canvas.addEventListener('pointerleave',()=>{el('brain-tooltip').hidden=true;});
  canvas.addEventListener('lostpointercapture',()=>{drag=undefined;});
  canvas.addEventListener('pointerup',event=>{if(!drag)return;if(!drag.moved){const rect=canvas.getBoundingClientRect();const x=(event.clientX-rect.left-width/2-offsetX)/scale,y=(event.clientY-rect.top-height/2-offsetY)/scale;const hit=[...points].reverse().find(p=>Math.hypot(p.x-x,p.y-y)<Math.max(p.radius*2,12/scale));if(hit)void showDetails(hit.item);}drag=undefined;});
  canvas.addEventListener('pointercancel',()=>{drag=undefined;});
  canvas.addEventListener('dblclick',event=>{
    const rect=canvas.getBoundingClientRect();
    const px=event.clientX-rect.left-width/2,py=event.clientY-rect.top-height/2;
    const worldX=(px-offsetX)/scale,worldY=(py-offsetY)/scale;
    const hit=[...points].reverse().find(p=>Math.hypot(p.x-worldX,p.y-worldY)<Math.max(p.radius*2,12/scale));
    if(hit){scale=Math.min(3,scale*1.35);offsetX=-hit.x*scale;offsetY=-hit.y*scale;draw();}
    else{scale=1;offsetX=0;offsetY=0;draw();}
  });
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();
    const rect=canvas.getBoundingClientRect();
    const px=event.clientX-rect.left-width/2;
    const py=event.clientY-rect.top-height/2;
    const previous=scale;
    scale=Math.max(.4,Math.min(3,scale*(event.deltaY<0?1.12:.89)));
    // Keep the world point under the cursor stationary while zooming.
    offsetX=px-(px-offsetX)*scale/previous;
    offsetY=py-(py-offsetY)*scale/previous;
    draw();
  },{passive:false});
  canvas.addEventListener('keydown',event=>{
    const step=event.shiftKey?80:32;
    switch(event.key){
      case 'ArrowLeft': offsetX+=step; break;
      case 'ArrowRight': offsetX-=step; break;
      case 'ArrowUp': offsetY+=step; break;
      case 'ArrowDown': offsetY-=step; break;
      case '+': case '=': scale=Math.min(3,scale*1.2); break;
      case '-': case '_': scale=Math.max(.4,scale/1.2); break;
      case '0': scale=1;offsetX=0;offsetY=0;break;
      default:return;
    }
    event.preventDefault();
    draw();
  });
  el<HTMLButtonElement>('brain-panel-toggle').addEventListener('click',event=>{const button=event.currentTarget as HTMLButtonElement;const panel=document.querySelector<HTMLElement>('.brain-panel')!;panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));button.setAttribute('aria-label',panel.hidden?'Показать настройки карты':'Скрыть настройки карты');requestAnimationFrame(resize);});
  el('brain-plus').addEventListener('click',()=>{scale=Math.min(3,scale*1.2);draw();});el('brain-minus').addEventListener('click',()=>{scale=Math.max(.4,scale/1.2);draw();});
  el('brain-center').addEventListener('click',()=>{scale=1;offsetX=0;offsetY=0;draw();});
  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach(b=>b.addEventListener('click',()=>{config.layout=b.dataset.layout as Layout;syncControls();draw();}));
  document.querySelectorAll<HTMLButtonElement>('[data-group]').forEach(b=>b.addEventListener('click',()=>{config.grouping=b.dataset.group as Grouping;syncControls();draw();}));
  document.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach(b=>b.addEventListener('click',()=>{config.theme=b.dataset.theme as Theme;syncControls();draw();}));
  speed.addEventListener('input',()=>{config.speed=Number(speed.value);syncControls();});size.addEventListener('input',()=>{config.size=Number(size.value);syncControls();draw();});
  labels.addEventListener('change',()=>{config.labels=labels.checked;draw();});
  let timer:ReturnType<typeof setTimeout>;search.addEventListener('input',()=>{++requestId;clearTimeout(timer);timer=setTimeout(()=>{void load();},250);});
  el('brain-refresh').addEventListener('click',()=>{void load();});el('brain-more').addEventListener('click',()=>{void load(true);});el('brain-save').addEventListener('click',save);
  el('command-load-more').addEventListener('click',()=>{void load(true);});
  el('brain-command-view').addEventListener('click',()=>setView('command'));el('brain-map-view').addEventListener('click',()=>setView('map'));el('command-open-map').addEventListener('click',()=>setView('map'));
  el('brain-export').addEventListener('click',()=>{const link=document.createElement('a');link.download='kagemiyura-memory.png';link.href=canvas.toDataURL('image/png');link.click();});
  el('brain-details-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  el('brain-open-chat').addEventListener('click',()=>{if(!selected)return;const id=selected.id;dialog.close();void openConversation(id).catch(()=>{el('brain-status').textContent='Не удалось открыть разговор. Попробуй ещё раз.';});});
  window.addEventListener('resize',()=>{if(visible)resize();});
  const observer=new ResizeObserver(()=>{if(visible)resize();});
  observer.observe(stage);
  syncControls();
  return {setVisible(value:boolean){if(value===visible)return;visible=value;if(value){resize();void load();updateClock();clock=setInterval(updateClock,1000);last=0;frame=requestAnimationFrame(animate);}else{cancelAnimationFrame(frame);clearInterval(clock);last=0;}}};
}
