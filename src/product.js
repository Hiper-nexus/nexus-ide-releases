import '@fontsource-variable/geist';
import './product.css';
import { initializeDownloads } from './downloads/ui.js';

void initializeDownloads();

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
document.querySelector('.waveform').replaceChildren(...Array.from({length:39},(_,i)=>{const bar=document.createElement('i');bar.style.height=`${8+Math.sin(i*.7)**2*42}px`;bar.style.animationDelay=`${i*24}ms`;return bar;}));
let voiceTimer;byId('voice-demo').addEventListener('click',()=>{clearTimeout(voiceTimer);document.querySelector('.voice-art').classList.add('voice-playing');byId('voice-status').textContent='EXEMPLO: PROMPT PRONTO PARA O AGENTE';byId('voice-sample').textContent='“Monte uma tela de agenda e revise os horários.”';voiceTimer=setTimeout(()=>document.querySelector('.voice-art').classList.remove('voice-playing'),4000);});
const video=byId('nexus-reel'),audio=byId('reel-audio'),reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
if(!reduced)video.play().catch(()=>{audio.textContent='Assistir ao filme ↗';});
audio.addEventListener('click',()=>{video.muted=!video.muted;audio.ariaPressed=String(!video.muted);audio.textContent=video.muted?'Ativar áudio ↗':'Silenciar áudio';video.play().catch(()=>{audio.textContent='Use os controles do vídeo para assistir.';});});
if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target);}},{threshold:.08});document.querySelectorAll('.reveal').forEach(el=>{if(!reduced)el.classList.add('reveal-ready');observer.observe(el);});const videoObserver=new IntersectionObserver(entries=>{if(!entries[0].isIntersecting)video.pause();else if(!reduced&&video.muted)video.play().catch(()=>{});});videoObserver.observe(video);}
window.addEventListener('pagehide',()=>{stop();clearTimeout(voiceTimer);video.pause();});
