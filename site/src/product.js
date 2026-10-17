import '@fontsource-variable/geist';
import './product.css';
import './prize.css';
import './calm.css';
import { applyCalmMotion } from './calm-motion.js';

// Antes de qualquer outra coisa: no Linux desktop a página nasce no movimento calmo (ver calm-motion.js).
const calmMotion = applyCalmMotion();
import { buildMarquee } from './sorteio/marquee.js';
import { startDrawSign } from './sorteio/reel.js';
import { initializeDownloads } from './downloads/ui.js';
import { initializePlans } from './plans/ui.js';
import { initializeHeroProof } from './hero/proof.js';
import { initMobileNav } from './nav.js';
import './voice/demo.js';

initMobileNav();
buildMarquee(document.getElementById('prize-marquee'));
startDrawSign(document.getElementById('prize-draw'));
const downloadsReady = initializeDownloads();
const plansReady = initializePlans();
void initializeHeroProof({ status: plansReady, releases: downloadsReady });

const cases={
  app:{name:'app de agenda',folder:'agenda',brief:'Uma agenda com cadastro de clientes e horários disponíveis.',plan:['Definir cadastro e regras de horário.','Separar interface e persistência.','Escrever os critérios de revisão.'],build:['Criar a tela de agenda.','Validar disponibilidade no serviço.','Cobrir conflitos de horário com testes.'],review:'Verificar sobreposição de horários, acesso aos dados e funcionamento da interface.',result:'Agenda pronta para sua revisão.'},
  bug:{name:'correção de bug',folder:'bug de horário',brief:'Um agendamento aceita dois clientes no mesmo horário. Investigue e corrija.',plan:['Reproduzir o conflito de agendamento.','Mapear o caminho da gravação.','Definir um teste que reproduz a falha.'],build:['Adicionar validação de disponibilidade.','Proteger a gravação concorrente.','Executar o teste de regressão.'],review:'Conferir a reprodução original, cenários de concorrência e o diff da correção.',result:'Correção organizada para você inspecionar.'},
  site:{name:'site de produto',folder:'novo site',brief:'Criar um site com identidade visual, vídeo e uma página de comunidade separada.',plan:['Mapear público e ação principal.','Definir páginas e referências.','Separar produto e comunidade.'],build:['Implementar as seções e o vídeo.','Construir uma experiência responsiva.','Verificar links, navegação e carregamento.'],review:'Comparar desktop e celular, verificar conteúdo, foco e controles.',result:'Site preparado para revisão e publicação.'},
};
const stageNames=['Defina o resultado','Organize o trabalho','Agentes em paralelo','Revise a entrega','Receba o resultado'];
let selected='app',stage=0,timer=null;
const byId=id=>document.getElementById(id);
function terminal(id,lines){byId(id).replaceChildren(...lines.map((text,index)=>{const p=document.createElement('p');p.className=index===0?'prompt-line':text.startsWith('✓')?'success-line':'terminal-step';p.textContent=text;return p;}));}
function stop(){clearTimeout(timer);timer=null;byId('play-demo').textContent='Executar demonstração ▶';}
function render(){
  const item=cases[selected];
  byId('demo-workspace').textContent=item.name;byId('case-name').textContent=item.folder;byId('mission-brief').textContent=item.brief;
  byId('stage-title').textContent=stageNames[stage];byId('stage-count').textContent=`${stage+1} / 5`;
  document.querySelectorAll('[data-case]').forEach(button=>{const active=button.dataset.case===selected;button.classList.toggle('active',active);button.ariaPressed=String(active);});
  document.querySelectorAll('[data-stage]').forEach(button=>{const i=Number(button.dataset.stage);button.classList.toggle('active',i===stage);button.classList.toggle('done',i<stage);button.ariaPressed=String(i===stage);});
  terminal('planner-output',['> '+item.brief,...(stage>0?item.plan:['Aguardando um objetivo.','No app, você pode escrever ou ditar.']),...(stage>1?['✓ Plano dividido em tarefas.']:[])]);
  terminal('builder-output',[stage<2?'> Preparado para receber uma tarefa.':'> Construindo a partir do plano.',...(stage>=2?item.build:['A execução tem contexto e critérios.','Você pode assumir este terminal.']),...(stage>=3?['✓ Exemplo pronto para revisão.']:[])]);
  byId('planner-state').textContent=stage===0?'Preparado':stage===1?'Planejando':'Plano pronto';byId('builder-state').textContent=stage<2?'Preparado':stage===2?'Construindo':'Em revisão';
  byId('review-title').textContent=stage===4?item.result:stage===3?'A entrega precisa de evidência.':'Do pedido à próxima decisão.';
  byId('review-copy').textContent=stage>=3?item.review:'O objetivo organiza o trabalho. Os papéis e as próximas etapas ficam visíveis.';
  byId('review-state').textContent=stage===4?'Revisão do exemplo concluída':stage===3?'Revisor em ação':'Aguardando revisão';
}
document.querySelectorAll('[data-case]').forEach(button=>button.addEventListener('click',()=>{stop();selected=button.dataset.case;stage=0;render();}));
document.querySelectorAll('[data-stage]').forEach(button=>button.addEventListener('click',()=>{stop();stage=Number(button.dataset.stage);render();}));
byId('play-demo').addEventListener('click',()=>{
  if(timer){stop();return;}if(stage===4)stage=0;render();byId('play-demo').textContent='Pausar demonstração ▮';
  function next(){if(stage>=4){stop();return;}stage++;render();timer=setTimeout(next,2400);}
  timer=setTimeout(next,1200);
});
byId('reset-demo').addEventListener('click',()=>{stop();stage=0;render();});render();
const roleText={orchestrator:['O objetivo não se perde.','O orquestrador organiza a missão, reparte o trabalho e acompanha as entregas.'],executor:['A tarefa vira mudança.','O executor trabalha no código, com o contexto e os critérios da missão.'],reviewer:['Antes de entregar, conferir.','O revisor inspeciona o resultado e identifica o que ainda precisa de correção.']};
document.querySelectorAll('[data-role]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-role]').forEach(b=>{b.classList.toggle('active',b===button);b.ariaPressed=String(b===button);});const [title,copy]=roleText[button.dataset.role];byId('role-title').textContent=title;byId('role-copy').textContent=copy;}));
const video=byId('nexus-reel'),audio=byId('reel-audio'),reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
if(!reduced)video.play().catch(()=>{audio.textContent='Assistir ao filme ↗';});
audio.addEventListener('click',()=>{video.muted=!video.muted;audio.ariaPressed=String(!video.muted);audio.textContent=video.muted?'Ativar áudio ↗':'Silenciar áudio';video.play().catch(()=>{audio.textContent='Use os controles do vídeo para assistir.';});});
if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target);}},{threshold:.08});document.querySelectorAll('.reveal').forEach(el=>{if(!reduced)el.classList.add('reveal-ready');observer.observe(el);});const videoObserver=new IntersectionObserver(entries=>{if(!entries[0].isIntersecting)video.pause();else if(!reduced&&video.muted)video.play().catch(()=>{});});videoObserver.observe(video);}
window.addEventListener('pagehide',()=>{stop();video.pause();});

// Manifesto: as palavras acendem uma a uma, na ordem de leitura, quando a seção entra na tela.
// Com redução de movimento ou modo calmo o texto já nasce inteiro (CSS cobre os dois casos).
(() => {
  const text = document.querySelector('.manifesto-text');
  if (!text || reduced || calmMotion || !('IntersectionObserver' in window)) return;
  let index = 0;
  const wrapWords = node => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        for (const part of child.textContent.split(/(\s+)/)) {
          if (!part.trim()) { frag.append(document.createTextNode(part)); continue; }
          const word = document.createElement('span');
          word.className = 'mw';
          word.style.setProperty('--mw-delay', `${Math.min(index * 90, 1800)}ms`);
          word.textContent = part;
          index += 1;
          frag.append(word);
        }
        node.replaceChild(frag, child);
      } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'BR') wrapWords(child);
    }
  };
  wrapWords(text);
  const section = text.closest('.manifesto');
  const observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) { section.classList.add('mw-in'); observer.disconnect(); }
  }, { threshold: 0.35 });
  observer.observe(section);
})();

// Nexus Data Café: o módulo 3D só baixa quando o visitante decide jogar.
(() => {
  const play = byId('datacafe-play'), stage = byId('datacafe-stage');
  if (!play || !stage) return;
  let game = null;
  play.addEventListener('click', async () => {
    if (game) return;
    stage.classList.add('dc-loading');
    play.textContent = 'Ligando o data center…';
    try {
      try { await document.fonts.load('80px VT323'); } catch { /* cai na monoespaçada */ }
      const { mountDataCafe } = await import('./datacafe/mount.js');
      game = mountDataCafe(stage, { host: byId('datacafe-host'), variant: 'embed', autostart: true });
      stage.classList.remove('dc-loading');
      stage.classList.add('dc-started');
      window.addEventListener('pagehide', event => { if (!event.persisted) game.dispose(); });
    } catch (error) {
      console.warn('Nexus Data Café:', error.message);
      stage.classList.remove('dc-loading');
      play.textContent = 'Jogo 3D indisponível aqui';
      play.disabled = true;
    }
  });
})();

// O filme do topo acompanha o ponteiro por poucos pixels, como um objeto sobre o piso. Só com mouse e sem redução de movimento.
(() => {
  const hero = document.querySelector('.product-hero'), reel = document.querySelector('.hero-reel');
  if (!hero || !reel || reduced || calmMotion || !matchMedia('(hover: hover)').matches) return;
  let frame = 0;
  hero.addEventListener('pointermove', event => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const box = hero.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5, y = (event.clientY - box.top) / box.height - 0.5;
      reel.style.setProperty('--px', `${(x * -14).toFixed(1)}px`);
      reel.style.setProperty('--py', `${(y * -10).toFixed(1)}px`);
    });
  });
  hero.addEventListener('pointerleave', () => { reel.style.removeProperty('--px'); reel.style.removeProperty('--py'); });
})();
