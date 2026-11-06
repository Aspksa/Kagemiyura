import type { Conversation, ConversationSummary } from '../shared/types.js';

type Layout = 'rings' | 'circle' | 'hex' | 'grid' | 'force' | 'hud';
type Grouping = 'months' | 'all';
type Theme = 'gold' | 'ocean' | 'violet' | 'rubric' | 'neon' | 'paper';
type BrainSettings = { layout: Layout; grouping: Grouping; theme: Theme; speed: number; size: number; labels: boolean; lineWidth: number; linkStrength: number };
type Point = { item: ConversationSummary; x: number; y: number; radius: number; color: string };
const defaults: BrainSettings = { layout:'rings', grouping:'months', theme:'ocean', speed:20, size:100, labels:true, lineWidth:100, linkStrength:45 };
const palettes: Record<Theme, string[]> = { gold:['#d9bd7e','#e7d8a3','#b49b67','#f0cb8c','#a68b60'], ocean:['#45d0c4','#80bff1','#75e0b3','#8998e8','#aecfe7'], violet:['#bf9ceb','#edbad0','#a2baf1','#dab1e5','#dfc597'], rubric:['#f0a251','#f26c49','#d7509b','#f4ca8b','#a47bdc'], neon:['#c4ff4a','#f44ac5','#39dce9','#7eff6d','#fdaf4b'], paper:['#b88843','#5577a5','#8862a8','#c59d59','#75828b'] };
function el<T extends HTMLElement>(id: string): T { const node = document.getElementById(id); if (!node) throw Error(`Missing ${id}`); return node as T; }
function settings(): BrainSettings {
  const value = {...defaults};
  try {
    const saved = JSON.parse(localStorage.getItem('kagemiyura-brain-v1') ?? '{}') as Partial<BrainSettings>;
    if (saved.layout && ['rings','circle','hex','grid','force','hud'].includes(saved.layout)) value.layout = saved.layout;
    if (saved.grouping && ['months','all'].includes(saved.grouping)) value.grouping = saved.grouping;
    if (saved.theme && ['gold','ocean','violet','rubric','neon','paper'].includes(saved.theme)) value.theme = saved.theme;
    if (typeof saved.speed === 'number' && Number.isFinite(saved.speed)) value.speed = Math.max(0, Math.min(100, saved.speed));
    if (typeof saved.size === 'number' && Number.isFinite(saved.size)) value.size = Math.max(70, Math.min(150, saved.size));
    if (typeof saved.lineWidth === 'number' && Number.isFinite(saved.lineWidth)) value.lineWidth=Math.max(20,Math.min(200,saved.lineWidth));
    if (typeof saved.linkStrength === 'number' && Number.isFinite(saved.linkStrength)) value.linkStrength=Math.max(0,Math.min(100,saved.linkStrength));
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
  const lineWidth = el<HTMLInputElement>('brain-line-width'); const linkStrength = el<HTMLInputElement>('brain-link-strength');
  let config = settings(); let items: ConversationSummary[] = []; let points: Point[] = []; let hasMore = false; let requestId = 0; let detailId = 0;
  let width = 1; let height = 1; let scale = 1; let offsetX = 0; let offsetY = 0; let phase = 0; let last = 0; let frame = 0; let visible = false;
  let selected: ConversationSummary | undefined; let suppressClickUntil=0; let drag: { x:number; y:number; startX:number; startY:number; moved:boolean } | undefined;
  let view: 'command'|'map' = 'command'; let clock: ReturnType<typeof setInterval> | undefined;
  let transition: { image: HTMLCanvasElement; started: number } | undefined;
  let forceKey = ''; let forcePoints: {x:number;y:number}[] = [];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const color = (index: number) => palettes[config.theme][index % 5]!;
  function syncControls() {
    speed.value = String(config.speed); size.value = String(config.size); labels.checked = config.labels;
    lineWidth.value=String(config.lineWidth);linkStrength.value=String(config.linkStrength);
    el('brain-line-width-value').textContent=`${config.lineWidth}%`;el('brain-link-strength-value').textContent=`${config.linkStrength}%`;
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
  function captureTransition() {
    if(!visible || reducedMotion.matches || config.speed===0 || canvas.width===0)return;
    const snapshot=document.createElement('canvas');
    snapshot.width=canvas.width;snapshot.height=canvas.height;
    snapshot.getContext('2d')?.drawImage(canvas,0,0);
    transition={image:snapshot,started:performance.now()};
  }
  function setView(next:'command'|'map') {
    if(view===next)return;
    captureTransition();
    view=next;el('brain-page').dataset.view=view;el('brain-view-title').textContent=view==='command'?'Команда':'Второй мозг';
    el('brain-command-view').setAttribute('aria-pressed',String(view==='command'));el('brain-map-view').setAttribute('aria-pressed',String(view==='map'));
    if(view==='command' && search.value.trim()){search.value='';void load();}
    requestAnimationFrame(()=>{if(visible){resize();draw();}});
  }
  function resize() {
    const rect = stage.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if(canvas.width===Math.round(rect.width*ratio) && canvas.height===Math.round(rect.height*ratio)) return;
    // Preserve a transition snapshot across view-dependent canvas resizing.
    if(transition && transition.image.width===0)transition=undefined;
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
    // Reference-video background: a faint staggered hexagonal blueprint texture.
    ctx.save();ctx.strokeStyle='rgba(38,82,102,.105)';ctx.lineWidth=.7;
    const hexR=23,hexDx=hexR*3.3,hexDy=hexR*2.86;
    for(let row=0;row<Math.ceil(height/hexDy)+1;row++)for(let col=0;col<Math.ceil(width/hexDx)+1;col++){
      const x=col*hexDx+(row%2)*hexDx*.5,y=row*hexDy;
      ctx.beginPath();for(let edge=0;edge<6;edge++){
        const angle=edge*Math.PI/3-Math.PI/6;
        const px=x+Math.cos(angle)*hexR,py=y+Math.sin(angle)*hexR;
        if(edge===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);
      }ctx.closePath();ctx.stroke();
    }ctx.restore();
    ctx.save(); ctx.translate(width/2+offsetX,height/2+offsetY); ctx.scale(scale,scale);
    ctx.lineWidth=config.lineWidth/100;
    const base = Math.max(100, Math.min(width,height)*(view==='command'?.34:.43)); const palette=palettes[config.theme]; const grouped=groups(); points=[];
    const stroke=(radius:number, alpha:number) => {ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.strokeStyle=`rgba(164,186,183,${alpha})`;ctx.lineWidth=0.8;ctx.stroke();};
    if(view==='command'||config.layout==='rings'||config.layout==='circle')for (const ring of [.22,.27,.83,.89,.95,.98]) stroke(base*ring,0.10);
    // Decorative stars are background only, not data or inferred relationships.
    for(let i=0;i<90;i++){ const x=((i*137)%997)/997*width-width/2;const y=((i*293)%991)/991*height-height/2;const twinkle=.08+(Math.sin(i*2.3+phase*5)+1)*.045;ctx.fillStyle=`rgba(170,191,194,${twinkle})`;ctx.fillRect(x,y,i%9===0?2:1,i%9===0?2:1); }
    // Procedural video-style energy: drawn in Canvas, never fetched from the network.
    if(!reducedMotion.matches && config.speed>0){
      ctx.save();
      const pulse=(Math.sin(phase*95)+1)/2;
      const aura=ctx.createRadialGradient(0,0,base*.02,0,0,base*.43);
      aura.addColorStop(0,`rgba(65,211,198,${.085+pulse*.055})`);
      aura.addColorStop(.45,'rgba(38,135,152,.045)');
      aura.addColorStop(1,'rgba(14,59,82,0)');
      ctx.fillStyle=aura;ctx.beginPath();ctx.arc(0,0,base*.43,0,Math.PI*2);ctx.fill();
      for(let k=0;k<3;k++){
        const r=base*(.25+k*.31);
        const a=phase*(k%2?-.8:1.1)+k*2.094;
        ctx.beginPath();ctx.arc(0,0,r,a,a+.30);
        ctx.strokeStyle=`rgba(79,227,213,${.12+pulse*.14})`;
        ctx.lineWidth=(2.2-k*.35)*config.lineWidth/100;
        ctx.shadowColor='#4fe3d5';ctx.shadowBlur=9;ctx.stroke();ctx.shadowBlur=0;
      }
      ctx.restore();
    }
    // Fine radial ticks create the concentric instrument-panel appearance.
    if(view==='map' && (config.layout==='rings'||config.layout==='hud')){
      ctx.save();ctx.strokeStyle='rgba(74,200,195,.23)';ctx.lineWidth=.65;
      for(let k=0;k<120;k++){
        const a=k*Math.PI/60,inner=base*.95,outer=base*(k%10===0?1.01:.975);
        ctx.beginPath();ctx.moveTo(Math.cos(a)*inner,Math.sin(a)*inner);
        ctx.lineTo(Math.cos(a)*outer,Math.sin(a)*outer);ctx.stroke();
      }
      ctx.restore();
    }
    const detailLevel=scale>=1.7?2:scale>=1.1?1:0;
    // Pixel density follows zoom, independent of animation time.
    const pixelScale=Math.max(.45,Math.min(2,scale));
    const total=Math.max(items.length,1); let index=0;
    const clusterCount=Math.max(grouped.length,1);
    const clusterCenters=grouped.map((_,i)=>{
      if(config.layout==='circle' && view==='map'){
        const cols=Math.max(1,Math.ceil(Math.sqrt(clusterCount*1.45)));
        const rows=Math.ceil(clusterCount/cols);
        const col=i%cols,row=Math.floor(i/cols);
        const stepX=Math.max(125,Math.min(240,base*1.75/Math.max(cols-1,1)));
        const stepY=Math.max(115,Math.min(205,base*1.75/Math.max(rows-1,1)));
        return {x:(col-(cols-1)/2)*stepX+(row%2)*stepX*.17,y:(row-(rows-1)/2)*stepY};
      }
      const a=i/clusterCount*Math.PI*2-Math.PI/2;
      const orbit=clusterCount===1?0:base*.57;
      return {x:Math.cos(a)*orbit,y:Math.sin(a)*orbit};
    });
    if(view==='map' && config.layout==='circle'){
      // Faint inter-island structure, visible without suggesting semantic relationships.
      ctx.save();ctx.lineWidth=.45*config.lineWidth/100;
      for(let i=1;i<clusterCenters.length;i++){
        const from=clusterCenters[i-1]!,to=clusterCenters[i]!;
        ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);
        ctx.strokeStyle='rgba(89,158,162,.12)';ctx.setLineDash([2,7]);ctx.stroke();
      }
      ctx.setLineDash([]);ctx.restore();
      grouped.forEach(([name,list],i)=>{
        const center=clusterCenters[i]!;
        // The reference uses square-pixel constellations, not large circular bubbles.
        const count=Math.min(detailLevel===2?220:detailLevel===1?150:90,Math.max(24,list.reduce((sum,item)=>sum+Math.min(item.messageCount,detailLevel===2?30:15),0)));
        const columns=Math.ceil(Math.sqrt(count*1.25));
        const rows=Math.ceil(count/columns);
        const gap=Math.max(5,Math.min(9,config.size/17));
        const clusterColor=color(i);
        ctx.save();
        for(let dot=0;dot<count;dot++){
          const col=dot%columns,row=Math.floor(dot/columns);
          const dx=(col-(columns-1)/2)*gap;
          const dy=(row-(rows-1)/2)*gap;
          // Stable gaps and opacity variation create the video-style dotted texture.
          if((dot*13+i*7)%17<3)continue;
          const opacity=(dot*7+i*3)%9===0?'bb':(dot+i)%3===0?'77':'44';
          ctx.fillStyle=clusterColor+opacity;
          const dotSize=(detailLevel===2?2.5:3.4)/pixelScale;
          ctx.fillRect(center.x+dx-dotSize/2,center.y+dy-dotSize/2,dotSize,dotSize);
        }
        // Soft breathing light around the island's center, without obscuring pixels.
        if(!reducedMotion.matches && config.speed>0){
          const glow=.12+.1*(1+Math.sin(phase*55+i*1.7))/2;
          const halo=ctx.createRadialGradient(center.x,center.y,0,center.x,center.y,Math.max(28,columns*gap*.65));
          halo.addColorStop(0,clusterColor+'33');
          halo.addColorStop(1,clusterColor+'00');
          ctx.globalAlpha=glow;
          ctx.fillStyle=halo;
          ctx.beginPath();ctx.arc(center.x,center.y,Math.max(28,columns*gap*.65),0,Math.PI*2);ctx.fill();
          ctx.globalAlpha=1;
        }
        ctx.font='bold 11px Consolas, monospace';ctx.fillStyle=clusterColor;
        ctx.textAlign='center';
        ctx.fillText(name.toLocaleUpperCase('ru-RU').slice(0,24),center.x,center.y-(rows*gap)/2-15);
        ctx.restore();
      });
    }
    grouped.forEach(([group, list], groupIndex)=>{
      list.forEach((item,localIndex)=>{
        let x=0,y=0;
        if(config.layout==='hex' && view==='map'){
          const cols=Math.max(1,Math.ceil(Math.sqrt(total)));const rows=Math.ceil(total/cols);const row=Math.floor(index/cols);
          const tile=Math.min(145,Math.max(22,base/(cols*.9+.4)))*config.size/100;
          // Hexagonal lattice with spacing that avoids cell overlap.
          const stepX=tile*Math.sqrt(3)*1.045,stepY=tile*1.5*1.045;
          x=(index%cols-(cols-1)/2+(row%2)*.5)*stepX;y=(row-(rows-1)/2)*stepY;
          const c=color(groupIndex);ctx.beginPath();for(let j=0;j<6;j++){const a=Math.PI/3*j-Math.PI/6,px=x+Math.cos(a)*tile,py=y+Math.sin(a)*tile;j===0?ctx.moveTo(px,py):ctx.lineTo(px,py);}ctx.closePath();ctx.fillStyle=c+'0b';ctx.fill();ctx.strokeStyle=c+'55';ctx.lineWidth=.8;ctx.stroke();
          ctx.beginPath();ctx.arc(x,y,tile*.22,0,Math.PI*2);ctx.strokeStyle=c+'66';ctx.stroke();
          ctx.beginPath();ctx.arc(x,y,tile*.34,0,Math.PI*2);ctx.strokeStyle=c+'28';ctx.stroke();
          ctx.beginPath();ctx.arc(x,y,tile*.48,0,Math.PI*2);ctx.strokeStyle=c+'19';ctx.stroke();
          // Animated hexagonal perimeter accents, kept subtle at normal zoom.
          if(!reducedMotion.matches && config.speed>0){
            const edge=Math.floor((phase*120+index*1.7)%6);
            const a=Math.PI/3*edge-Math.PI/6,b=a+Math.PI/3;
            ctx.save();ctx.beginPath();
            ctx.moveTo(x+Math.cos(a)*tile,y+Math.sin(a)*tile);
            ctx.lineTo(x+Math.cos(b)*tile,y+Math.sin(b)*tile);
            ctx.strokeStyle=c+'bb';ctx.lineWidth=1.6*config.lineWidth/100;
            ctx.shadowColor=c;ctx.shadowBlur=7;ctx.stroke();ctx.restore();
          }
          for(let edge=0;edge<6;edge++){const a=Math.PI/3*edge-Math.PI/6;ctx.beginPath();ctx.moveTo(x+Math.cos(a)*tile*.74,y+Math.sin(a)*tile*.74);ctx.lineTo(x+Math.cos(a)*tile*.88,y+Math.sin(a)*tile*.88);ctx.strokeStyle=c+'aa';ctx.lineWidth=1.3;ctx.stroke();}
          const dots=Math.min(item.messageCount,detailLevel===2?100:detailLevel===1?70:32);for(let k=0;k<dots;k++){const a=k*2.39996,rad=Math.sqrt((k+1)/Math.max(dots,1))*tile*.70;ctx.fillStyle=c+(k%4===0?'cc':'66');const dot=2/pixelScale;ctx.fillRect(x+Math.cos(a)*rad-dot/2,y+Math.sin(a)*rad-dot/2,dot,dot);}
          ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fillStyle=c;ctx.shadowColor=c;ctx.shadowBlur=12;ctx.fill();ctx.shadowBlur=0;
          if(config.labels && (detailLevel>0 || total<=25)){ctx.font='bold 9px Consolas, monospace';ctx.fillStyle=c;ctx.textAlign='center';ctx.fillText(item.title.length>22?item.title.slice(0,21)+'…':item.title,x,y-tile*.45,Math.max(20,tile*1.45));}
          points.push({item,x,y,radius:tile*.90,color:c});index++;return;
        }
        if(config.layout==='rings' || view==='command') {
          const a=index/total*Math.PI*2-Math.PI/2+phase;
          const outer=base*(.76+(index%4)*.064); x=Math.cos(a)*outer; y=Math.sin(a)*outer;
          const mid=base*.47; const innerX=Math.cos(a)*mid,innerY=Math.sin(a)*mid; const c=color(groupIndex);
          ctx.beginPath();ctx.moveTo(innerX,innerY);ctx.lineTo(x,y);ctx.strokeStyle=c+'25';ctx.lineWidth=.65*config.lineWidth/100;ctx.stroke();
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
        else if(config.layout==='circle') {
          // Reference video: separate constellation islands rather than overlapping orbits.
          const center=clusterCenters[groupIndex]!;
          const stepX=Math.max(125,Math.min(240,base*1.75/Math.max(Math.ceil(Math.sqrt(clusterCount*1.45))-1,1)));
          const angle=localIndex*2.399963229728653;
          const radius=Math.sqrt((localIndex+.5)/Math.max(list.length,1))*Math.min(48,stepX*.24);
          x=center.x+Math.cos(angle)*radius;
          y=center.y+Math.sin(angle)*radius;
        }
        else if(config.layout==='force') {const p=forceLayout(total,base)[index]!;x=p.x;y=p.y;}
        else if(config.layout==='grid'||config.layout==='hud') {const cols=Math.ceil(Math.sqrt(total)); const spacing=Math.min(95,base*1.6/Math.max(cols-1,1)); x=(index%cols-(cols-1)/2)*spacing;y=(Math.floor(index/cols)-(Math.ceil(total/cols)-1)/2)*spacing;}
        else {const cols=Math.ceil(Math.sqrt(total));const spacing=Math.min(100,base*1.6/Math.max(cols-1,1));const row=Math.floor(index/cols);x=(index%cols-(cols-1)/2+(row%2)*.5)*spacing;y=(row-(Math.ceil(total/cols)-1)/2)*spacing*.87;}
        index++; const radius=Math.max(5,Math.min(12,(5+Math.log2(item.messageCount+1))*config.size/100)); const c=color(groupIndex); points.push({item,x,y,radius,color:c});
        if(config.layout==='hud' && view==='map'){ctx.strokeStyle=c+'55';ctx.lineWidth=.8;ctx.strokeRect(x-radius*2.4,y-radius*2.4,radius*4.8,radius*4.8);ctx.strokeStyle=c+'aa';ctx.beginPath();ctx.moveTo(x-radius*2.4,y-radius*1.5);ctx.lineTo(x-radius*2.4,y-radius*2.4);ctx.lineTo(x-radius*1.5,y-radius*2.4);ctx.stroke();}
        if(config.layout==='circle' && view==='map'){
          // Video-style micro-square constellations around each conversation anchor.
          // Dot count is bounded so long conversations do not overload Canvas.
          const density=Math.min(detailLevel===2?96:detailLevel===1?64:28,Math.max(8,item.messageCount));
          const spacing=Math.max(3.2,Math.min(6,config.size/24));
          const columns=Math.max(4,Math.ceil(Math.sqrt(density)));
          const rows=Math.ceil(density/columns);
          ctx.save();
          for(let dot=0;dot<density;dot++){
            const col=dot%columns,row=Math.floor(dot/columns);
            const dx=(col-(columns-1)/2)*spacing;
            const dy=(row-(rows-1)/2)*spacing;
            // Keep the node unobstructed; small deterministic offsets form a dotted cloud.
            if(Math.hypot(dx,dy)<radius*1.5)continue;
            const alpha=dot%7===0?'bb':dot%3===0?'77':'44';
            ctx.fillStyle=c+alpha;
            ctx.fillRect(x+dx-1.2,y+dy-1.2,2.4,2.4);
          }
          ctx.restore();
          ctx.beginPath();ctx.moveTo(clusterCenters[groupIndex]!.x,clusterCenters[groupIndex]!.y);ctx.lineTo(x,y);
          ctx.strokeStyle=`rgba(140,210,205,${config.linkStrength/400})`;
          ctx.lineWidth=.7*config.lineWidth/100;ctx.stroke();
        }
        if(config.layout==='circle' && view==='map' && !reducedMotion.matches && config.speed>0){
          // Moving light packets travel along the group-to-node links.
          const origin=clusterCenters[groupIndex]!;
          const dx=x-origin.x,dy=y-origin.y;
          const distance=Math.hypot(dx,dy);
          if(distance>5){
            const t=(phase*11+index*.173)%1;
            const px=origin.x+dx*t,py=origin.y+dy*t;
            ctx.save();
            ctx.globalAlpha=.3+.7*Math.sin(t*Math.PI);
            ctx.fillStyle=c;ctx.shadowColor=c;ctx.shadowBlur=10;
            ctx.beginPath();ctx.arc(px,py,1.8,0,Math.PI*2);ctx.fill();
            if(detailLevel>0){ctx.beginPath();ctx.moveTo(px-dx/distance*9,py-dy/distance*9);ctx.lineTo(px,py);ctx.strokeStyle=c+'77';ctx.lineWidth=1.2;ctx.stroke();}
            ctx.restore();
          }
        }

        if(config.layout==='hex' && view==='map'){
          // Hex cells are interactive targets, without circular badges over the constellation.
          points[points.length-1]!.radius=Math.max(radius,Math.min(145,Math.max(22,base/(Math.ceil(Math.sqrt(total))*.9+.4)))*config.size/100*.65);
          return;
        }
        ctx.beginPath();ctx.arc(x,y,radius*1.45,0,Math.PI*2);ctx.strokeStyle=c+'aa';ctx.lineWidth=.8;ctx.fillStyle='#04111b';ctx.fill();ctx.stroke();
        if(config.layout==='rings'||view==='command'){ctx.strokeStyle=c;ctx.lineWidth=.8;ctx.strokeRect(x-3,y-2.5,6,4.5);ctx.beginPath();ctx.moveTo(x-1,y+2);ctx.lineTo(x-2,y+4);ctx.stroke();}
        else {ctx.beginPath();ctx.arc(x,y,radius*.7,0,Math.PI*2);ctx.fillStyle=c;ctx.shadowColor=c;ctx.shadowBlur=8;ctx.fill();ctx.shadowBlur=0;
          ctx.beginPath();ctx.arc(x,y,radius*2.1,0,Math.PI*2);ctx.strokeStyle=c+'22';ctx.lineWidth=.7;ctx.stroke();}
        if(config.labels && (total<=70 || detailLevel>0) && config.layout!=='rings' && view==='map'){ctx.font='10px Consolas, monospace';ctx.fillStyle='#c6c9c7';ctx.textAlign='center';ctx.fillText(item.title.length>24?item.title.slice(0,23)+'…':item.title,x,y+radius+15);}
      });
      if(config.grouping==='months' && list.length && config.layout==='rings' && grouped.length<=24) {const start=index-list.length;const a=(start+(list.length-1)/2)/total*Math.PI*2-Math.PI/2+phase;ctx.font='9px Consolas, monospace';ctx.fillStyle=color(groupIndex);ctx.textAlign='center';ctx.fillText(group.toLocaleUpperCase('ru-RU'),Math.cos(a)*base*.76,Math.sin(a)*base*.76);}
    });
    // Draw the ring-mode endpoint markers, not only their inner anchors.
    if(view==='map' && config.layout==='rings'){
      ctx.save();
      for(let i=0;i<points.length;i++){
        const p=points[i]!,a=i/Math.max(points.length,1)*Math.PI*2-Math.PI/2+phase;
        const r=base*(.76+(i%4)*.064),x=Math.cos(a)*r,y=Math.sin(a)*r;
        ctx.beginPath();ctx.arc(x,y,2.3,0,Math.PI*2);ctx.fillStyle=p.color;ctx.fill();
        ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.strokeStyle=p.color+'55';ctx.lineWidth=.7;ctx.stroke();
      }
      ctx.restore();
    }
    if(view==='map' && config.layout==='circle' && clusterCount>1){
      ctx.save();ctx.globalAlpha=.24;ctx.strokeStyle=palette[0]!;ctx.lineWidth=.65;
      for(const center of clusterCenters){ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(center.x,center.y);ctx.stroke();}
      ctx.restore();
    }
    if(view==='command') {
      // Reference-inspired instrument core. Decorative rings do not imply facts.
      ctx.save();
      const coreRadius=Math.max(21,base*.115);
      const motion=!reducedMotion.matches && config.speed>0;
      const breathe=motion?.78+.22*Math.sin(phase*85):.85;
      const glow=ctx.createRadialGradient(0,0,0,0,0,coreRadius*2.7);
      glow.addColorStop(0,`rgba(92,235,216,${.18+.08*breathe})`);
      glow.addColorStop(.35,'rgba(36,150,158,.075)');
      glow.addColorStop(1,'rgba(36,150,158,0)');
      ctx.fillStyle=glow;ctx.beginPath();ctx.arc(0,0,coreRadius*2.7,0,Math.PI*2);ctx.fill();
      for(let ring=0;ring<4;ring++){
        const radius=coreRadius*(.78+ring*.24);
        ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);
        ctx.strokeStyle=ring%2===0?'rgba(103,225,215,.27)':'rgba(133,177,187,.14)';
        ctx.lineWidth=ring===0?1.1:.65;ctx.stroke();
      }
      for(let tick=0;tick<96;tick++){
        const angle=tick*Math.PI/48;
        const inner=coreRadius*(tick%8===0?1.31:1.40);
        const outer=coreRadius*(tick%8===0?1.58:1.49);
        ctx.beginPath();ctx.moveTo(Math.cos(angle)*inner,Math.sin(angle)*inner);
        ctx.lineTo(Math.cos(angle)*outer,Math.sin(angle)*outer);
        ctx.strokeStyle=tick%8===0?'rgba(101,231,216,.44)':'rgba(110,170,182,.17)';
        ctx.lineWidth=tick%8===0?1:.55;ctx.stroke();
      }
      const count=200;
      for(let n=0;n<count;n++){
        const a=n*2.39996323+(motion?phase*(n%3===0?.2:-.12):0);
        const r=Math.sqrt((n+.5)/count)*coreRadius*.68;
        const x=Math.cos(a)*r,y=Math.sin(a)*r;
        ctx.fillStyle=n%9===0?'rgba(178,255,235,.94)':n%3===0?'rgba(99,229,206,.72)':'rgba(69,169,176,.49)';
        const dot=n%17===0?1.9:1.05;ctx.fillRect(x-dot/2,y-dot/2,dot,dot);
      }
      ctx.restore();
    } else if(config.layout==='rings'||config.layout==='circle'||items.length===0){ctx.beginPath();ctx.arc(0,0,29,0,Math.PI*2);ctx.fillStyle='#020a11';ctx.fill();ctx.strokeStyle=palette[0]!;ctx.lineWidth=1.3;ctx.stroke();
    ctx.beginPath();ctx.arc(0,0,34,0,Math.PI*2);ctx.strokeStyle=palette[0]+'44';ctx.lineWidth=1;ctx.stroke();
    ctx.font='italic 23px Georgia, serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=palette[0]!;ctx.fillText('К',0,1);ctx.textBaseline='alphabetic';ctx.font='9px Consolas, monospace';ctx.fillStyle='#91a7a8';ctx.fillText('КАГЭМИЮРА',0,51);}
    ctx.restore();
    if(transition){
      const progress=Math.min(1,(performance.now()-transition.started)/380);
      if(progress>=1) transition=undefined;
      else{
        ctx.save();ctx.globalAlpha=(1-progress)*(1-progress);
        ctx.drawImage(transition.image,0,0,width,height);ctx.restore();
      }
    }
  }
  function switchLayout(next:Layout){
    if(config.layout===next)return;
    transition=undefined;
    captureTransition();
    config.layout=next;syncControls();draw();
  }
  function animate(time:number) { if(!visible) return; if(!last || time-last>=33){if(last && !reducedMotion.matches && config.speed>0)phase += Math.min(time-last,100)*config.speed/100*0.00008;
    if(transition || (!reducedMotion.matches && config.speed>0))draw(); last=time;} frame=requestAnimationFrame(animate); }
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
  canvas.addEventListener('pointerup',event=>{if(!drag)return;if(!drag.moved){const rect=canvas.getBoundingClientRect();const x=(event.clientX-rect.left-width/2-offsetX)/scale,y=(event.clientY-rect.top-height/2-offsetY)/scale;const hit=[...points].reverse().find(p=>Math.hypot(p.x-x,p.y-y)<Math.max(p.radius*2,12/scale));if(hit && Date.now()>suppressClickUntil)void showDetails(hit.item);}drag=undefined;});
  canvas.addEventListener('pointercancel',()=>{drag=undefined;});
  canvas.addEventListener('dblclick',event=>{suppressClickUntil=Date.now()+400;
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
  el('brain-fit').addEventListener('click',()=>{
    if(!points.length){scale=1;offsetX=0;offsetY=0;draw();return;}
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
    const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    const contentWidth=Math.max(120,maxX-minX+100),contentHeight=Math.max(120,maxY-minY+100);
    scale=Math.max(.4,Math.min(3,Math.min(width*.85/contentWidth,height*.82/contentHeight)));
    offsetX=-(minX+maxX)/2*scale;offsetY=-(minY+maxY)/2*scale;draw();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach(b=>b.addEventListener('click',()=>{switchLayout(b.dataset.layout as Layout);}));
  document.querySelectorAll<HTMLButtonElement>('[data-group]').forEach(b=>b.addEventListener('click',()=>{config.grouping=b.dataset.group as Grouping;syncControls();draw();}));
  document.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach(b=>b.addEventListener('click',()=>{config.theme=b.dataset.theme as Theme;syncControls();draw();}));
  speed.addEventListener('input',()=>{config.speed=Number(speed.value);syncControls();});size.addEventListener('input',()=>{config.size=Number(size.value);syncControls();draw();});
  labels.addEventListener('change',()=>{config.labels=labels.checked;draw();});
  lineWidth.addEventListener('input',()=>{config.lineWidth=Number(lineWidth.value);syncControls();draw();});
  linkStrength.addEventListener('input',()=>{config.linkStrength=Number(linkStrength.value);syncControls();draw();});
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
