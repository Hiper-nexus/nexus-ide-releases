/** Nexus Data Café: monta a cena num contêiner qualquer e roda o jogo.
 * Os módulos puros (grade, interação, energia, racks, tickets) decidem;
 * este arquivo só liga entrada, simulação, arte e os eventos do HUD. */
import {
  ACESFilmicToneMapping, Color, DirectionalLight, Fog, HemisphereLight, PCFShadowMap,
  PerspectiveCamera, PointLight, Scene, Vector3, WebGLRenderer,
} from 'three';
import { createKit, Particles } from './kit.js';
import { buildDatacenter } from './datacenter.js';
import { createDev } from './character.js';
import { LAYOUT } from './layout.js';
import { MODELS } from './models.js';
import { PALETTE } from './palette.js';
import { createGrid, slideMove } from './grid.js';
import { createInteractables, register, nearest, advanceHold } from './interact.js';
import { WALK, intentFrom, worldDirection, walkStep } from './walk.js';
import { RIG, clampYaw, clampPitch, createCamera, cameraStep, wheelZoom, pinchZoom } from './rig.js';
import { DESK, createDesk, resetDesk, sit, deskStep, deployPlan, seatPose } from './desk.js';
import { joystickInput, JOYSTICK_RADIUS } from './touch.js';
import { ENERGY, createEnergy, energyStep, drink, refill, speedScale, energyLevel } from './energy.js';
import { DRINK, createDrinks, drinkAdvance, drinkCan, drinkReason, drinkWait, turboLeft, turboLevel, turboEnding, turboEffects } from './energy-drink.js';
import { FICTIONAL_NOTE } from './freezer-art.js';
import { formatClock } from './shift.js';
import { createRacks, installGpu, reboot, rackStep, rackState, poweredCount, operationalCount, installedIds, incidentIds, allPowered } from './racks.js';
import { ticketsFrom, badgesFor, speedPerk, TICKET_XP, BADGES } from './tickets.js';
import { createProgression, scoreTicket, progressionStep, closeShift, awardMessage } from './progression.js';
import { dropUnavailable, missionView } from './missions.js';
import { comboLevel, comboMultiplier } from './combo.js';
import { saveProgress, initialProgress } from './progress.js';
import { attractPose, revealWeight, REVEAL, IDLE_NUDGE, glanceTarget, glanceRange, prizeObjective, shouldPointToPrize } from './showcase.js';

const KEYS = { w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right' };
const ACTION_KEYS = new Set(['e', ' ', 'enter']);
const RACK_TICK = 0.25;
const ENERGY_TICK = 0.1;
const DELIVERY_SECONDS = 7;
const GAME_TICK = 0.2;
/** Com o data center completo não há o que instalar: essas missões saem do baralho. */
const NO_INSTALL = ['install'];
const ANY_MISSION = [];
const STEP_LENGTH = 0.62;
/** Quanto a lata fica na mão antes de o dev guardá-la. */
const SIP_SECONDS = 0.8;
const TRAIL_EVERY = 0.045;
const FROST_EVERY = 0.35;
const label = (text, { duration = 1, blocked = false, holdId = null } = {}) => Object.freeze({ text, duration, blocked, holdId });
const modelOf = id => MODELS.find(model => model.id === id);
const STATION = LAYOUT.workstation;
const SEATED_LABELS = {
  ready: label('Segure para fazer deploy · toque para levantar'),
  running: label('Deploy em andamento · continue segurando'),
  paused: label('Deploy pausado · segure para continuar · toque para levantar'),
};

class DataCafeWorld {
  constructor(host, options = {}) {
    this.host = host;
    this.on = options.on ?? {};
    this.audio = options.audio ?? null;
    this.calm = Boolean(options.reducedMotion);
    this.joystick = options.joystick ?? null;
    this.aborter = new AbortController();
    this.listen = { signal: this.aborter.signal };
    const mobile = Math.min(innerWidth, innerHeight) < 760 || matchMedia('(pointer: coarse)').matches;
    this.mobile = mobile;

    this.renderer = new WebGLRenderer({ antialias: !mobile, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.25 : 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;
    this.renderer.domElement.className = 'dc-canvas';
    host.prepend(this.renderer.domElement);

    this.scene = new Scene();
    this.scene.background = new Color(PALETTE.bar);
    this.scene.fog = new Fog(PALETTE.bar, 26, 48);
    this.camera = new PerspectiveCamera(40, 1, 0.1, 80);
    const center = { x: LAYOUT.width / 2, z: LAYOUT.height / 2 };
    this.scene.add(new HemisphereLight(0xffd0dc, 0x3a2232, 1.45));
    const sun = new DirectionalLight(0xffb58a, 2.9);
    sun.position.set(center.x - 10, 12, center.z + 9);
    sun.target.position.set(center.x + 1, 0, center.z);
    sun.castShadow = true;
    sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 11, bottom: -11, near: 1, far: 45 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    // Borda de sombra mais larga: o serrilhado da sombra própria do dev andava junto com ele.
    sun.shadow.radius = 3;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    const fill = new DirectionalLight(0x9fb2ff, 0.5);
    fill.position.set(center.x + 14, 8, center.z + 6);
    this.scene.add(fill);

    this.kit = createKit();
    this.dc = buildDatacenter(this.kit, { scene: this.scene, layout: LAYOUT, models: MODELS, tier: mobile ? 'mobile' : 'desktop' });
    const glow = new PointLight(PALETTE.ember, 1.3, 5, 2);
    glow.position.set(this.dc.coffee.spout.x, 1.8, this.dc.coffee.spout.z + 0.6);
    this.scene.add(glow);
    this.dev = createDev(this.kit);
    this.dev.group.scale.setScalar(1.15);
    this.scene.add(this.dev.group);
    this.particles = new Particles(this.kit, this.scene, this.calm ? 120 : 260);
    this.goalPoint = null;
    this.pointer = document.createElement('span');
    this.pointer.className = 'dc-pointer';
    this.pointer.setAttribute('aria-hidden', 'true');
    this.pointer.hidden = true;
    host.append(this.pointer);

    // Estado do jogo: sempre substituído por valores novos dos módulos puros.
    this.grid = createGrid(LAYOUT);
    this.progress = options.progress ?? initialProgress();
    const valid = new Set(MODELS.map(model => model.id));
    this.racks = createRacks(MODELS.map(model => model.id), this.progress.racksOn.filter(id => valid.has(id)));
    for (const id of installedIds(this.racks)) this.dc.racks.get(id).setState('on');
    this.energy = createEnergy();
    this.carrying = false;
    this.version = 1;
    this.shownVersion = 0;
    this.tickets = [];
    this.energyLow = false;
    // Freezer do Nexus+ (marca fictícia, só do jogo). O relógio só corre com o jogo rodando:
    // pausar ou esconder a aba congela estoque, gelo e turbo.
    this.clock = 0;
    this.drinks = createDrinks(0);
    this.freezerLabels = new Map();
    this.freezerStatus = null;
    this.sip = 0;
    this.turboOn = false;
    this.turboFx = false;
    this.turboTickAt = 0;
    this.toldNexus = false;
    this.dc.freezer?.setStock(this.drinks.stock);

    this.body = { x: LAYOUT.spawn.x, z: LAYOUT.spawn.z, vx: 0, vz: 0, heading: 0, speed: 0 };
    this.walkOut = {};
    this.intent = { x: 0, y: 0 };
    this.direction = { x: 0, z: 0 };
    this.keys = { up: false, down: false, left: false, right: false };
    this.analog = { x: 0, y: 0 };
    // Câmera: o jogador pede giro, inclinação e zoom; rig.js decide o resto.
    this.view = { yaw: 0, pitch: RIG.pitch, zoom: 1 };
    this.cam = createCamera();
    this.camInput = { playing: false, calm: this.calm, aspect: 1, body: this.body, yaw: 0, pitch: RIG.pitch, zoom: 1, focus: null, seat: null, idle: { x: center.x, z: center.z - 0.5 } };
    this.pointers = new Map();
    this.pinch = null;
    // Mesa do terminal: estado puro em desk.js, a cena só aplica pose, prompt e eventos.
    this.desk = createDesk();
    /** XP que o último deploy rendeu de verdade (combo e missão incluídos), para o monitor e o prompt. */
    this.deployGain = DESK.xp;
    this.deskEvents = [];
    this.seatFrom = { x: 0, z: 0, heading: 0 };
    this.seatPose = { x: 0, z: 0, heading: 0, blend: 0 };
    this.seatView = { blend: 0, screen: STATION.screen };
    this.seatLabel = null;
    this.seatLabels = new Map();
    this.leaveSeat = false;
    this.plan = { version: -1, seconds: -1, value: null };
    this.terminal = { phase: 'standing', shown: 0, result: null, failure: null, progress: 0, status: '', blink: true };
    this.toldDesk = false;
    this.scratch = new Vector3();
    // Vitrine do sorteio: passeio antes de começar, espiada no painel ao começar e o cutucão do farol.
    this.attract = { x: center.x, z: center.z - 0.5, yaw: 0, zoom: 1 };
    this.glance = { ...glanceTarget(LAYOUT), range: 8, weight: 0 };
    this.reveal = null;
    this.prizeSeen = false;
    this.missionsDone = 0;
    this.idle = 0;
    this.nudged = false;
    this.dc.prize.setPathVisible(true);

    this.hold = { item: null, label: null, duration: 1, elapsed: 0 };
    this.holdShown = false;
    this.holding = false;
    this.latch = false;
    this.blockedToast = false;
    this.promptItem = undefined;
    this.promptLabel = undefined;
    this.clocks = { racks: 0, energy: 0, delivery: 0, step: 0, dataset: 0, game: 0 };
    this.game = createProgression(undefined, this.unavailableMissions());
    this.playing = false;
    this.paused = false;
    this.visible = true;
    this.disposed = false;
    this.frame = 0;
    this.lastTime = 0;
    this.slowFrames = 0;

    this.items = createInteractables();
    this.registerInteractables();
    this.bindInput();
    this.observe();
    this.resize();
    host.classList.add('dc-ready');
    this.refresh();
    this.paintTerminal(this.deployPlan(), 0);
    this.on.energy?.(energyLevel(this.energy), this.energy.tired);
    this.on.xp?.({ progress: this.progress, gained: 0, leveledUp: false });
    this.emitGame();
    this.on.ready?.();
  }

  // ---------- Interações ----------
  registerInteractables() {
    for (const rack of LAYOUT.racks) {
      const model = modelOf(rack.id);
      const art = this.dc.racks.get(rack.id);
      const labels = {
        install: label(`Instalar GPU no rack ${model.name}`, { duration: 1.4 }),
        need: label(`Rack ${model.name} desligado: pegue uma GPU na doca`, { blocked: true }),
        reboot: label(`Reiniciar ${model.name}`, { duration: 2 }),
        live: label(`${model.name} no ar · ${model.blurb}`, { blocked: true }),
      };
      register(this.items, {
        id: `rack:${rack.id}`, x: art.x, z: art.front + 0.05, radius: 1.15,
        label: game => {
          const state = rackState(game.racks, rack.id);
          if (state === 'off') return game.carrying ? labels.install : labels.need;
          return state === 'incident' ? labels.reboot : labels.live;
        },
        onComplete: () => this.completeRack(rack.id),
      });
    }
    const coffee = { drink: label('Tomar café', { duration: 1 }), full: label('Você já está no pico do café', { blocked: true }) };
    register(this.items, {
      id: 'coffee', x: this.dc.coffee.x, z: this.dc.coffee.z + 0.45, radius: 1.05,
      label: game => (game.energy.value < ENERGY.max - 0.03 ? coffee.drink : coffee.full),
      onComplete: () => this.drinkCoffee(),
    });
    const dock = { take: label('Pegar uma GPU', { duration: 0.7 }), carrying: label('Você já está carregando uma GPU', { blocked: true }), empty: label('Doca vazia: a próxima entrega já vem', { blocked: true }) };
    register(this.items, {
      id: 'dock', x: this.dc.dock.x, z: this.dc.dock.z + 0.45, radius: 2.6,
      label: game => (game.carrying ? dock.carrying : game.dc.dock.count() > 0 ? dock.take : dock.empty),
      onComplete: () => this.takeCrate(),
    });
    const freezer = this.dc.freezer;
    if (freezer) {
      register(this.items, {
        id: 'energy', x: freezer.x, z: freezer.front + 0.45, radius: 1.15,
        label: game => game.freezerLabel(),
        onComplete: () => this.takeCan(),
      });
    }
    const board = label('Ver o sorteio do grupo', { duration: 0.3 });
    // O painel tem cinco células de largura: o alcance cobre a frente toda, de ponta a ponta.
    register(this.items, {
      id: 'board', x: LAYOUT.board.x + LAYOUT.board.width / 2, z: LAYOUT.board.z + 1.25, radius: LAYOUT.board.width / 2 + 0.2,
      label: () => board,
      onComplete: () => this.seePrize(),
    });
    const live = label('Ver as lives', { duration: 0.3 });
    register(this.items, { id: 'live', x: LAYOUT.live.x + 0.5, z: LAYOUT.live.z + 0.95, radius: 0.95, label: () => live, onComplete: () => this.on.station?.('live') });
    const nocLabels = new Map();
    register(this.items, {
      id: 'noc', x: LAYOUT.noc.x + LAYOUT.noc.width / 2, z: LAYOUT.noc.z + 0.95, radius: 2.2,
      label: game => {
        const count = game.tickets.length;
        if (!nocLabels.has(count)) nocLabels.set(count, label(count ? `NOC: ${count} ${count === 1 ? 'ticket aberto' : 'tickets abertos'}` : 'NOC: tudo em ordem', { blocked: true }));
        return nocLabels.get(count);
      },
    });
    const desk = { sit: label('Sentar no PC', { duration: 0.45 }), busy: label('Com a GPU na mão não dá para sentar: instale no rack', { blocked: true }) };
    register(this.items, {
      id: 'desk', x: STATION.seat.x, z: STATION.chair.z + 1.05, radius: 1.05,
      label: game => (game.carrying ? desk.busy : desk.sit),
      onComplete: () => this.sitDown(),
    });
  }

  /** Abre o painel do sorteio; quem já viu não é mais cutucado pelo farol nem pelo caminho no chão. */
  seePrize() {
    this.on.station?.('group');
    if (this.prizeSeen) return;
    this.prizeSeen = true;
    this.dc.prize.setPathVisible(false);
    this.version++;
  }

  ticketFor(kind, rackId = null) {
    const id = rackId ? `${kind}:${rackId}` : kind;
    return this.tickets.find(ticket => ticket.id === id) ?? { id, kind, rackId, xp: TICKET_XP[kind] };
  }

  completeRack(id) {
    const art = this.dc.racks.get(id);
    const model = modelOf(id);
    const state = rackState(this.racks, id);
    if (state === 'off' && this.carrying) {
      const ticket = this.ticketFor('install', id);
      this.racks = installGpu(this.racks, id);
      this.carrying = false;
      art.setState('on');
      art.pulse();
      this.particles.burst(art.x, 1.9, art.front, { count: this.calm ? 10 : 28, colors: [model.color, PALETTE.pink, PALETTE.ink], speed: 2.6, up: 3 });
      this.audio?.success();
      this.award(ticket, `${model.name} no ar`);
    } else if (state === 'incident') {
      const ticket = this.ticketFor('incident', id);
      this.racks = reboot(this.racks, id);
      art.setState('on');
      art.pulse();
      this.particles.burst(art.x, 1.6, art.front, { count: this.calm ? 8 : 20, colors: [PALETTE.green, PALETTE.ink], speed: 2, up: 2.4 });
      this.audio?.success();
      this.award(ticket, `${model.name} de volta`);
    }
    this.version++;
  }

  drinkCoffee() {
    const wasLow = this.energy.value < ENERGY.low;
    const ticket = this.ticketFor('coffee');
    this.energy = drink(this.energy);
    const { spout } = this.dc.coffee;
    this.particles.burst(spout.x, spout.y + 0.3, spout.z, { count: this.calm ? 6 : 18, colors: [0xfaf0e8, PALETTE.ember], speed: 0.4, up: 1.1, gravity: -0.6, life: 1.4, size: 1.3 });
    this.audio?.coffee();
    this.on.energy?.(energyLevel(this.energy), false);
    if (wasLow) this.award(ticket, 'Café tomado');
    else this.on.toast?.('Café tomado. Energia cheia.');
    this.version++;
  }

  takeCrate() {
    if (this.carrying || !this.dc.dock.takeCrate()) return;
    this.carrying = true;
    this.audio?.pickup();
    this.particles.burst(this.body.x, 0.8, this.body.z, { count: this.calm ? 4 : 10, colors: [PALETTE.kraft, PALETTE.pink], speed: 1.2, up: 1.5 });
    this.on.toast?.('GPU na mão. Leve até um rack desligado.');
    this.version++;
  }

  /** O que o freezer diz agora: pegar, gelando, vazio ou com a GPU na mão. Rótulos em cache, chave numérica: o loop nunca aloca. */
  freezerLabel() {
    const stock = this.drinks.stock;
    const reason = drinkReason(this.drinks, this.clock);
    const wait = drinkWait(this.drinks, this.clock);
    const key = this.carrying ? -1 : reason === 'ready' ? stock : reason === 'cooling' ? 100 + wait : 200 + wait;
    let item = this.freezerLabels.get(key);
    if (!item) {
      if (this.carrying) item = label('Com a GPU na mão não dá para abrir o freezer: instale no rack', { blocked: true });
      else if (reason === 'ready') item = label(`Pegar um Nexus+ (${stock})`, { duration: 0.9, holdId: 'freezer-ready' });
      else if (reason === 'cooling') item = label(`Gelando… ${formatClock(wait)}`, { blocked: true });
      else item = label(`Vazio. Repondo… ${formatClock(wait)}`, { blocked: true });
      this.freezerLabels.set(key, item);
    }
    return item;
  }

  /** Pega uma lata: enche o café, liga o turbo e começa o gole. */
  takeCan() {
    const result = drinkCan(this.drinks, this.clock);
    if (!result.ok) return;
    this.drinks = result.state;
    this.energy = refill(this.energy);
    this.sip = SIP_SECONDS;
    this.dc.freezer.setStock(this.drinks.stock);
    const before = new Set(this.progress.badges);
    const progress = { ...this.progress, cans: (this.progress.cans ?? 0) + 1 };
    const badges = badgesFor(progress, this.racks);
    this.progress = { ...progress, badges };
    saveProgress(this.progress);
    this.particles.burst(this.body.x, 1.1, this.body.z, { count: this.calm ? 8 : 26, colors: [PALETTE.pink, 0xcfefff, PALETTE.ink], speed: 2.2, up: 2.4 });
    this.audio?.can();
    const seals = badges.filter(badge => !before.has(badge)).map(badge => ` · selo: ${BADGES[badge]}`).join('');
    this.on.toast?.(`Nexus+ gelado: turbo por ${DRINK.turbo} s.${this.toldNexus ? '' : ` ${FICTIONAL_NOTE}`}${seals}`);
    this.toldNexus = true;
    this.on.energy?.(energyLevel(this.energy), false);
    this.on.xp?.({ progress: this.progress, gained: 0, leveledUp: false });
    this.emitTurbo();
    this.version++;
  }

  /** O turbo no HUD (chip e borda rosa) e o tique dos últimos segundos. */
  emitTurbo() {
    const left = turboLeft(this.drinks, this.clock);
    const on = left > 0;
    if (on || this.turboOn) this.on.turbo?.(left, turboLevel(this.drinks, this.clock));
    this.turboOn = on;
    const fx = on && !this.calm;
    if (fx !== this.turboFx) { this.turboFx = fx; this.on.turboFx?.(fx); }
    if (turboEnding(this.drinks, this.clock)) {
      const second = Math.ceil(left);
      if (second !== this.turboTickAt) { this.turboTickAt = second; this.audio?.turboTick(); }
    } else this.turboTickAt = 0;
  }

  award(ticket, what) {
    const before = new Set(this.progress.badges);
    const unavailable = this.unavailableMissions();
    const result = scoreTicket(this.game, this.progress, ticket, undefined, unavailable, { turbo: turboLeft(this.drinks, this.clock) > 0 });
    this.game = { ...result.state, missions: dropUnavailable(result.state.missions, undefined, unavailable) };
    this.missionsDone += result.finished.length;
    const progress = { ...result.progress, racksOn: installedIds(this.racks) };
    const badges = badgesFor(progress, this.racks);
    this.progress = { ...progress, badges };
    saveProgress(this.progress);
    this.floatText(`+${result.xpGained + result.bonus} XP`);
    // Um aviso só, com tudo o que este ticket rendeu: nada é atropelado por outro aviso.
    this.on.toast?.(awardMessage(what, result, badges.filter(badge => !before.has(badge))));
    this.on.xp?.({ progress: this.progress, gained: result.xpGained + result.bonus, leveledUp: result.leveledUp });
    if (result.leveledUp) this.audio?.levelUp();
    else if (result.finished.length) this.audio?.mission();
    else if (this.game.combo.streak > 1) this.audio?.combo(this.game.combo.streak);
    this.emitGame();
    return result.xpGained + result.bonus;
  }

  // ---------- Combo, missões e turno ----------
  unavailableMissions() {
    return allPowered(this.racks) ? NO_INSTALL : ANY_MISSION;
  }

  emitGame() {
    this.on.missions?.(missionView(this.game.missions));
    this.emitClock();
  }

  /** O que muda com o relógio: medidor do combo e tempo do turno. */
  emitClock() {
    const { combo, shift } = this.game;
    this.on.combo?.(combo.streak, comboMultiplier(combo), comboLevel(combo));
    this.on.shift?.(shift.left, shift.score, this.progress.bestShift);
    this.emitTurbo();
  }

  advanceGame(dt) {
    const step = progressionStep(this.game, dt);
    this.game = step.state;
    if (step.shiftOver) {
      const closed = closeShift(this.game, this.progress);
      const had = new Set(this.progress.badges);
      this.game = closed.state;
      this.progress = { ...closed.progress, badges: badgesFor(closed.progress, this.racks) };
      const seals = this.progress.badges.filter(badge => !had.has(badge)).map(badge => ` Selo: ${BADGES[badge]}.`).join('');
      saveProgress(this.progress);
      // Turno sem ponto nenhum fecha calado: ninguém quer um aviso de zero a cada três minutos.
      if (closed.score > 0) {
        this.audio?.shiftEnd();
        this.on.toast?.(`${closed.record ? `Turno encerrado: ${closed.score} pontos. Recorde novo!` : `Turno encerrado: ${closed.score} pontos. Recorde: ${this.progress.bestShift}.`}${seals}`);
        this.on.xp?.({ progress: this.progress, gained: 0, leveledUp: false });
      }
    }
    this.emitClock();
  }

  refresh() {
    this.tickets = ticketsFrom(this.racks, this.energy, MODELS);
    const powered = poweredCount(this.racks);
    this.on.tickets?.(this.tickets);
    this.on.racks?.(operationalCount(this.racks), MODELS.length, powered);
    this.dc.setNoc(this.tickets.map(ticket => ticket.title), this.racks.order.map(id => rackState(this.racks, id)));
    this.audio?.fan(powered / MODELS.length);
    this.goalPoint = this.playing ? this.objective() : null;
    this.dc.setObjective(this.goalPoint);
    this.on.objective?.(this.goalPoint ? { text: this.goalPoint.text, kind: this.goalPoint.kind } : null);
    this.shownVersion = this.version;
  }

  /** Com a GPU na mão, o rack mais perto muda enquanto o dev anda: reavalia algumas vezes por segundo. */
  trackGoal(dt) {
    if (!this.carrying || this.goalPoint?.kind !== 'install') return;
    this.clocks.goal = (this.clocks.goal ?? 0) + dt;
    if (this.clocks.goal < 0.3) return;
    this.clocks.goal = 0;
    const next = this.objective();
    if (next && (next.x !== this.goalPoint.x || next.z !== this.goalPoint.z)) {
      this.goalPoint = next;
      this.dc.setObjective(next);
    }
  }

  /** Para onde o jogador deveria ir agora: incidente, café baixo, rack livre com a GPU na mão ou a doca. */
  objective() {
    const top = this.tickets[0];
    const nudge = shouldPointToPrize({ topKind: top?.kind ?? null, carrying: this.carrying, visited: this.prizeSeen, finishedMissions: this.missionsDone, idleSeconds: this.idle });
    if (nudge) return prizeObjective(LAYOUT);
    if (!top) return null;
    if (top.kind === 'incident') { const rack = this.dc.racks.get(top.rackId); return { x: rack.x, z: rack.front + 0.4, kind: 'incident', text: top.title }; }
    if (top.kind === 'coffee') return { x: this.dc.coffee.x, z: this.dc.coffee.z + 0.6, kind: 'coffee', text: top.title };
    if (this.carrying) {
      // O rack desligado mais perto de quem carrega, não o primeiro da lista.
      let best = null, bestDistance = Infinity;
      for (const ticket of this.tickets) {
        if (ticket.kind !== 'install') continue;
        const rack = this.dc.racks.get(ticket.rackId);
        const distance = Math.hypot(rack.x - this.body.x, rack.front - this.body.z);
        if (distance < bestDistance) { best = rack; bestDistance = distance; }
      }
      return best ? { x: best.x, z: best.front + 0.4, kind: 'install', text: 'Leve a GPU até um rack desligado (o farol rosa mostra o mais perto)' } : null;
    }
    const waiting = this.tickets.filter(ticket => ticket.kind === 'install').length;
    return { x: this.dc.dock.x, z: this.dc.dock.z + 0.7, kind: 'install', text: `Pegue uma GPU na doca · ${waiting} ${waiting === 1 ? 'rack esperando' : 'racks esperando'}` };
  }

  // ---------- Mesa do terminal ----------
  sitDown() {
    if (this.desk.phase !== 'standing') return;
    this.desk = sit(this.desk);
    Object.assign(this.seatFrom, { x: this.body.x, z: this.body.z, heading: this.body.heading });
    this.body.vx = this.body.vz = this.body.speed = 0;
    this.promptItem = this.promptLabel = undefined;
    this.seatLabel = null;
    this.on.prompt?.(null);
    this.dc.highlight(null);
    this.audio?.sit?.();
  }

  /** Pode fazer deploy? Recalcula só quando o jogo muda ou o segundo da espera vira. */
  deployPlan() {
    const seconds = Math.ceil(this.desk.cooldown), cache = this.plan;
    if (cache.version !== this.version || cache.seconds !== seconds) {
      const incident = incidentIds(this.racks)[0];
      cache.value = deployPlan({ cooldown: this.desk.cooldown, powered: poweredCount(this.racks), incident: incident ? modelOf(incident).name : null });
      cache.version = this.version;
      cache.seconds = seconds;
    }
    return cache.value;
  }

  seatedLabel(text) {
    if (!this.seatLabels.has(text)) this.seatLabels.set(text, label(text, { blocked: true }));
    return this.seatLabels.get(text);
  }

  sitStep(dt, seconds) {
    intentFrom(this.keys, this.analog, this.intent);
    const plan = this.deployPlan();
    const events = this.deskEvents;
    events.length = 0;
    this.desk = deskStep(this.desk, {
      dt, holding: this.holding, plan, calm: this.calm, leave: this.leaveSeat,
      moving: Math.hypot(this.intent.x, this.intent.y) > 0.3,
    }, events);
    this.leaveSeat = false;
    for (const event of events) this.deskEvent(event, plan);
    const desk = this.desk;
    if (desk.phase !== 'standing') {
      seatPose(desk, this.seatFrom, STATION.seat, STATION.stand, this.seatPose);
      Object.assign(this.body, { x: this.seatPose.x, z: this.seatPose.z, heading: this.seatPose.heading, vx: 0, vz: 0, speed: 0 });
    }
    this.seatView.blend = desk.phase === 'standing' ? 0 : this.seatPose.blend;
    // Prompt e barra do HUD enquanto sentado; de pé quem cuida é interact().
    let next = null;
    if (desk.phase === 'seated') next = plan.blocked ? this.seatedLabel(`${plan.blocked} · toque para levantar`) : SEATED_LABELS.ready;
    else if (desk.phase === 'acting') next = this.holding ? SEATED_LABELS.running : SEATED_LABELS.paused;
    else if (desk.phase === 'done') next = this.seatedLabel(desk.result === 'ok' ? `Deploy no ar · +${this.deployGain} XP` : `${desk.failure} · reinicie o rack e tente de novo`);
    if (desk.phase !== 'standing' && next !== this.seatLabel) { this.seatLabel = next; this.on.prompt?.(next); }
    if (desk.phase === 'acting') { this.on.hold?.(desk.progress); this.holdShown = true; } else if (this.holdShown && desk.phase !== 'standing') { this.on.hold?.(0); this.holdShown = false; }
    this.paintTerminal(plan, seconds);
  }

  deskEvent(event, plan) {
    if (event === 'seated' && !this.toldDesk) { this.toldDesk = true; this.on.toast?.('Sentado no PC. Segure para fazer deploy; toque, ande ou Esc para levantar.'); }
    else if (event === 'typing') this.audio?.typing?.();
    else if (event === 'blocked') this.on.toast?.(plan.blocked);
    else if (event === 'abort') this.on.toast?.('Deploy cancelado.');
    else if (event === 'rise') this.audio?.stand?.();
    else if (event === 'failed') { this.audio?.alert(); this.on.toast?.(`${this.desk.failure}. Reinicie o rack e tente de novo.`); }
    else if (event === 'deployed') {
      const { screen } = STATION;
      this.particles.burst(screen.x, screen.y + 0.3, screen.z + 0.1, { count: this.calm ? 8 : 22, colors: [PALETTE.green, PALETTE.pink, PALETTE.ink], speed: 1.4, up: 2 });
      this.audio?.success();
      this.deployGain = this.award({ id: 'deploy', kind: 'deploy', xp: DESK.xp }, 'Deploy no ar');
      this.version++;
    } else if (event === 'standing') {
      // De pé de novo, no piso livre ao lado da cadeira (sem animação o passo de levantar não acontece).
      Object.assign(this.body, { x: STATION.stand.x, z: STATION.stand.z, vx: 0, vz: 0, speed: 0 });
      // interact() volta a mandar no prompt.
      this.seatLabel = null;
      this.promptItem = this.promptLabel = undefined;
      this.on.prompt?.(null);
      if (this.holdShown) { this.on.hold?.(0); this.holdShown = false; }
    }
  }

  paintTerminal(plan, seconds) {
    const desk = this.desk, view = this.terminal;
    let status;
    if (desk.phase === 'acting') status = this.holding ? 'Deploy em andamento' : 'Pausado · segure para continuar';
    else if (desk.phase === 'done') status = desk.result === 'ok' ? `Deploy no ar · +${this.deployGain} XP` : 'Reinicie o rack e tente de novo';
    else if (plan.blocked) status = plan.blocked;
    else if (desk.phase === 'standing') status = plan.fail ? 'Há incidente aberto: o canary vai falhar' : 'Deploy pronto · sente e segure';
    else status = 'Segure para fazer deploy';
    view.phase = desk.phase;
    view.shown = desk.shown;
    view.result = desk.result;
    view.failure = desk.failure;
    view.progress = desk.progress;
    view.status = status;
    // O cursor só pisca com alguém sentado; de pé o monitor repinta no máximo uma vez por segundo.
    view.blink = this.calm || desk.phase === 'standing' || Math.floor(seconds * 2) % 2 === 0;
    this.dc.workstation?.show(view);
  }

  // ---------- Simulação ----------
  simulate(dt) {
    this.clock += dt;
    const freezer = this.dc.freezer;
    if (freezer) {
      const previous = this.drinks;
      this.drinks = drinkAdvance(this.drinks, this.clock);
      if (this.drinks !== previous) freezer.setStock(this.drinks.stock);
      const reason = drinkReason(this.drinks, this.clock);
      if (reason !== this.freezerStatus) { this.freezerStatus = reason; freezer.setStatus(reason); }
    }
    if (this.sip > 0) this.sip = Math.max(0, this.sip - dt);
    this.clocks.energy += dt;
    if (this.clocks.energy >= ENERGY_TICK) {
      const previous = this.energy;
      this.energy = energyStep(this.energy, this.clocks.energy, { moving: this.body.speed > 0.3, carrying: this.carrying });
      this.clocks.energy = 0;
      if (this.energy !== previous) {
        this.on.energy?.(energyLevel(this.energy), this.energy.tired);
        if (this.energy.tired && !previous.tired) this.on.toast?.('Sem café, o dev ficou lento. Passe na cafeteira.');
        const low = this.energy.value < ENERGY.low;
        if (low !== this.energyLow) { this.energyLow = low; this.version++; }
      }
    }
    this.clocks.racks += dt;
    if (this.clocks.racks >= RACK_TICK) {
      const { state, events } = rackStep(this.racks, this.clocks.racks);
      this.racks = state;
      this.clocks.racks = 0;
      for (const event of events) {
        this.dc.racks.get(event.id).setState('incident');
        this.audio?.alert();
        this.on.toast?.(`Incidente: ${modelOf(event.id).name} caiu. Corra reiniciar!`);
        this.version++;
      }
    }
    this.clocks.game += dt;
    if (this.clocks.game >= GAME_TICK) { this.advanceGame(this.clocks.game); this.clocks.game = 0; }
    this.clocks.delivery += dt;
    if (this.clocks.delivery >= DELIVERY_SECONDS) {
      this.clocks.delivery = 0;
      if (this.dc.dock.count() < 4) {
        this.dc.dock.refill(1);
        this.particles.burst(this.dc.dock.x, 0.6, this.dc.dock.z, { count: this.calm ? 4 : 12, colors: [PALETTE.gold, PALETTE.kraft], speed: 1.5, up: 1.8 });
        this.version++;
      }
    }
  }

  move(dt) {
    intentFrom(this.keys, this.analog, this.intent);
    worldDirection(this.intent, this.cam.yaw, this.direction);
    const scale = speedScale(this.energy) * speedPerk(this.progress.level) * (this.carrying ? WALK.carryScale : 1) * turboEffects(this.drinks, this.clock).speed;
    const out = walkStep(this.body, this.direction, dt, scale, this.walkOut);
    const next = slideMove(this.grid, this.body, { x: out.dx, z: out.dz }, WALK.radius);
    const moved = Math.hypot(next.x - this.body.x, next.z - this.body.z);
    this.body.vx = next.x === this.body.x ? 0 : out.vx;
    this.body.vz = next.z === this.body.z ? 0 : out.vz;
    this.body.x = next.x;
    this.body.z = next.z;
    this.body.heading = out.heading;
    this.body.speed = dt > 0 ? moved / dt : 0;
    this.clocks.step += moved;
    if (this.clocks.step >= STEP_LENGTH) { this.clocks.step = 0; this.audio?.footstep(); }
  }

  interact(dt) {
    const item = nearest(this.items, this.body, this);
    const current = item ? item.label(this) : null;
    if (item !== this.promptItem || current !== this.promptLabel) {
      // O aviso de ação bloqueada toca uma vez por alvo: o relógio do rótulo (Gelando… 0:12) não o rearma a cada segundo.
      const blockedNow = Boolean(current?.blocked);
      if (item !== this.promptItem || blockedNow !== this.promptBlocked) this.blockedToast = false;
      this.promptBlocked = blockedNow;
      this.promptItem = item;
      this.promptLabel = current;
      this.on.prompt?.(current);
      this.dc.highlight(item);
    }
    const result = advanceHold(this.hold, item, current, this.holding && !this.latch, dt);
    if (result === 'blocked' && !this.blockedToast) { this.on.toast?.(current.text); this.audio?.denied(); this.blockedToast = true; }
    if (result === 'progress') { this.on.hold?.(this.hold.elapsed / this.hold.duration); this.holdShown = true; }
    else if (this.holdShown) { this.on.hold?.(0); this.holdShown = false; }
    if (result === 'done') { this.latch = true; item.onComplete?.(); }
  }

  // ---------- Quadro ----------
  resize = () => {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.schedule();
  };

  schedule = () => {
    if (!this.frame && this.visible && !this.disposed) this.frame = requestAnimationFrame(this.render);
  };

  render = time => {
    this.frame = 0;
    const raw = this.lastTime ? (time - this.lastTime) / 1000 : 0.016;
    const dt = Math.min(raw, 0.05);
    this.lastTime = time;
    const seconds = time / 1000;
    const running = !this.paused;
    if (running && this.playing) {
      this.sitStep(dt, seconds);
      this.trackIdle(dt);
      if (this.desk.phase === 'standing') this.move(dt);
      this.simulate(dt);
      if (this.desk.phase === 'standing') this.interact(dt);
      if (this.version !== this.shownVersion) this.refresh();
      else this.trackGoal(dt);
    }
    if (running) {
      this.steam(dt);
      this.frost(dt);
      this.trail(dt);
      this.dc.freezer?.setDoor(this.sip > 0 || (this.holdShown && this.promptItem?.id === 'energy'));
      this.dev.group.position.set(this.body.x, 0, this.body.z);
      this.dev.setMotion({ speed: this.playing ? this.body.speed : 0, heading: this.body.heading, carrying: this.carrying, tired: this.energy.tired, calm: this.calm, seat: this.seatView.blend, typing: this.desk.phase === 'acting' && this.holding, drinking: this.sip > 0 }, dt);
      this.dc.update(dt, seconds, this.calm);
    }
    const effects = running ? this.particles.update(dt) : false;
    this.updateCamera(dt, seconds);
    this.renderer.render(this.scene, this.camera);
    this.updatePointer();
    this.clocks.dataset += raw;
    if (this.clocks.dataset > 0.5) {
      this.clocks.dataset = 0;
      Object.assign(this.host.dataset, { devX: this.body.x.toFixed(2), devZ: this.body.z.toFixed(2), carrying: String(this.carrying), drawCalls: String(this.renderer.info.render.calls), racksOn: String(poweredCount(this.racks)) });
    }
    if (raw > 0.034 && this.renderer.getPixelRatio() > 1) {
      if (++this.slowFrames > 45) { this.renderer.setPixelRatio(1); this.resize(); }
    } else this.slowFrames = Math.max(0, this.slowFrames - 1);
    const animate = running && (this.playing || !this.calm);
    if (animate || effects || this.pointers.size) this.schedule();
  };

  /** Parado há muito tempo? O farol passa a apontar o painel do sorteio, e volta ao normal quando o jogador mexe. */
  trackIdle(dt) {
    const active = this.holding || this.desk.phase !== 'standing' || Math.hypot(this.intent.x, this.intent.y) > 0.1;
    this.idle = active ? 0 : this.idle + dt;
    const nudged = this.idle >= IDLE_NUDGE;
    if (nudged !== this.nudged) { this.nudged = nudged; this.version++; }
  }

  /** Vapor subindo da cafeteira: dois cubinhos a cada ~0,5 s. Nada com redução de movimento. */
  steam(dt) {
    if (this.calm) return;
    this.clocks.steam = (this.clocks.steam ?? 0) + dt;
    if (this.clocks.steam < 0.55) return;
    this.clocks.steam = 0;
    const { spout } = this.dc.coffee;
    this.particles.burst(spout.x, spout.y + 0.2, spout.z, { count: 2, colors: [0xf4ece6], speed: 0.06, up: 0.5, gravity: -0.4, life: 1.6, size: 0.8 });
  }

  /** Vapor frio escorrendo do freezer quando o dev chega perto ou a porta está aberta. Nada com redução de movimento. */
  frost(dt) {
    const freezer = this.dc.freezer;
    if (!freezer || this.calm) return;
    const near = Math.hypot(this.body.x - freezer.x, this.body.z - (freezer.front + 0.45)) < 2.8;
    if (!near && freezer.doorOpen() < 0.3) return;
    this.clocks.frost = (this.clocks.frost ?? 0) + dt;
    if (this.clocks.frost < FROST_EVERY) return;
    this.clocks.frost = 0;
    this.particles.burst(freezer.x + (Math.random() - 0.5) * 1.5, 1.05, freezer.front + 0.12, { count: 2, colors: [0xcfefff, 0xf4fbff], speed: 0.12, up: 0.1, gravity: 0.35, life: 1.7, size: 0.85 });
  }

  /** Rastro de faíscas rosa atrás do dev enquanto dura o turbo e ele anda. Nada com redução de movimento. */
  trail(dt) {
    if (this.calm || !this.playing || this.body.speed < 1 || turboLeft(this.drinks, this.clock) <= 0) return;
    this.clocks.trail = (this.clocks.trail ?? 0) + dt;
    if (this.clocks.trail < TRAIL_EVERY) return;
    this.clocks.trail = 0;
    const heading = this.body.heading;
    this.particles.burst(this.body.x - Math.sin(heading) * 0.22, 0.32, this.body.z - Math.cos(heading) * 0.22, { count: 2, colors: [PALETTE.pink, PALETTE.ember, PALETTE.ink], speed: 0.4, up: 0.6, gravity: 1.4, life: 0.5, size: 0.7 });
  }

  /** A espiada no painel do sorteio logo depois de começar; null quando não há (ou acabou). */
  stepReveal(dt) {
    const reveal = this.reveal;
    if (!reveal || !this.playing) return null;
    reveal.t += dt;
    if (reveal.t >= REVEAL.duration) { this.reveal = null; return null; }
    const glance = this.glance;
    glance.weight = revealWeight(reveal.t, this.calm);
    glance.range = glanceRange(this.camera.aspect);
    return glance;
  }

  updateCamera(dt, seconds) {
    const input = this.camInput;
    if (!this.playing) {
      // Antes de começar a câmera passeia pelo salão com o painel do sorteio em vista.
      attractPose(seconds, this.calm, this.attract);
      input.idle.x = this.attract.x;
      input.idle.z = this.attract.z;
      if (!this.calm && !this.pointers.size) this.view.yaw = this.attract.yaw;
    }
    input.glance = this.stepReveal(dt);
    input.playing = this.playing;
    input.calm = this.calm;
    input.aspect = this.camera.aspect;
    input.yaw = this.view.yaw;
    input.pitch = this.view.pitch;
    input.zoom = this.playing ? this.view.zoom : this.view.zoom * this.attract.zoom;
    // Aproxima enquanto o jogador segura uma ação; sentado, enquadra o monitor.
    input.focus = this.holdShown && this.promptItem ? this.promptItem : null;
    input.seat = this.seatView.blend > 0 ? this.seatView : null;
    const cam = cameraStep(this.cam, input, LAYOUT, dt);
    this.camera.position.set(cam.x, cam.y, cam.z);
    this.camera.lookAt(cam.tx, cam.ty, cam.tz);
  }

  /** Seta na borda da tela quando o objetivo está fora do quadro. */
  updatePointer() {
    const goal = this.goalPoint;
    if (!goal || !this.playing) { if (!this.pointer.hidden) this.pointer.hidden = true; return; }
    const p = this.scratch.set(goal.x, 1.2, goal.z).project(this.camera);
    const onScreen = p.z < 1 && Math.abs(p.x) < 0.92 && Math.abs(p.y) < 0.85;
    if (onScreen) { if (!this.pointer.hidden) this.pointer.hidden = true; return; }
    let x = p.x, y = p.y;
    if (p.z > 1) { x = -x; y = -y; }
    const scale = 1 / Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.8, 1e-6);
    x *= scale; y *= scale;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const angle = Math.atan2(-y, x);
    this.pointer.hidden = false;
    this.pointer.dataset.kind = goal.kind;
    this.pointer.style.transform = `translate(${((x * 0.5 + 0.5) * w).toFixed(1)}px,${((-y * 0.5 + 0.5) * h).toFixed(1)}px) translate(-50%,-50%) rotate(${angle.toFixed(3)}rad)`;
  }

  floatText(text) {
    const span = document.createElement('span');
    span.className = 'dc-float';
    span.textContent = text;
    const point = this.scratch.set(this.body.x, 1.6, this.body.z).project(this.camera);
    span.style.left = `${(point.x * 0.5 + 0.5) * this.host.clientWidth}px`;
    span.style.top = `${(-point.y * 0.5 + 0.5) * this.host.clientHeight}px`;
    this.host.append(span);
    setTimeout(() => span.remove(), 1100);
  }

  // ---------- Entrada ----------
  keydown = event => {
    if (!this.host.contains(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'escape') {
      if (this.playing && this.desk.phase !== 'standing') { event.preventDefault(); this.leaveSeat = true; this.schedule(); return; }
      this.clearInput(); this.host.blur(); return;
    }
    if (!this.playing || this.paused) return;
    this.reveal = null;
    if (KEYS[key]) { event.preventDefault(); this.keys[KEYS[key]] = true; this.schedule(); return; }
    if (ACTION_KEYS.has(key)) { event.preventDefault(); if (!event.repeat) this.holdStart(); return; }
    if (key === 'm') this.on.menu?.();
  };

  keyup = event => {
    const key = event.key.toLowerCase();
    if (KEYS[key]) this.keys[KEYS[key]] = false;
    if (ACTION_KEYS.has(key)) this.holdEnd();
  };

  clearInput = () => {
    for (const key of Object.keys(this.keys)) this.keys[key] = false;
    this.analog.x = this.analog.y = 0;
    this.holdEnd();
    this.pointers.clear();
    this.pinch = null;
  };

  holdStart = () => {
    if (!this.playing || this.paused || this.disposed) return;
    this.reveal = null;
    this.audio?.unlock();
    this.holding = true;
    this.schedule();
  };

  holdEnd = () => {
    this.holding = false;
    this.latch = false;
    this.blockedToast = false;
  };

  bindInput() {
    const on = (target, name, handler, extra = {}) => target.addEventListener(name, handler, { ...this.listen, ...extra });
    const canvas = this.renderer.domElement;
    const capture = (element, event) => { try { element.setPointerCapture(event.pointerId); } catch { /* ponteiro sintético */ } };
    canvas.style.touchAction = 'none';
    on(this.host, 'keydown', this.keydown);
    on(window, 'keyup', this.keyup);
    on(window, 'blur', this.clearInput);
    // Um dedo ou o mouse orbitam um pouco (giro e inclinação); dois dedos fazem pinça.
    const pair = () => { const [a, b] = this.pointers.values(); return Math.hypot(a.x - b.x, a.y - b.y); };
    on(canvas, 'pointerdown', event => {
      this.host.focus({ preventScroll: true });
      this.reveal = null;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      capture(canvas, event);
      if (this.pointers.size === 2) this.pinch = { distance: pair(), zoom: this.view.zoom };
      this.schedule();
    });
    on(canvas, 'pointermove', event => {
      const last = this.pointers.get(event.pointerId);
      if (!last) return;
      const dx = event.clientX - last.x, dy = event.clientY - last.y;
      last.x = event.clientX;
      last.y = event.clientY;
      if (this.pinch && this.pointers.size >= 2) this.view.zoom = pinchZoom(this.pinch.zoom, this.pinch.distance, pair());
      else if (!this.pinch) {
        this.view.yaw = clampYaw(this.view.yaw - dx * 0.004);
        this.view.pitch = clampPitch(this.view.pitch + dy * 0.003);
      }
      this.schedule();
    });
    const release = event => {
      if (!this.pointers.delete(event.pointerId)) return;
      if (!this.pointers.size) this.pinch = null;
    };
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) on(canvas, name, release);
    // Roda (e pinça do trackpad, que chega com ctrl): só com o jogo em foco, e no limite do zoom a página rola.
    on(canvas, 'wheel', event => {
      if (!this.playing || this.paused || !this.host.contains(document.activeElement)) return;
      const zoom = wheelZoom(this.view.zoom, event.deltaY * (event.deltaMode === 1 ? 16 : 1) * (event.ctrlKey ? 8 : 1));
      if (zoom === this.view.zoom) return;
      event.preventDefault();
      this.view.zoom = zoom;
      this.schedule();
    }, { passive: false });
    const stick = this.joystick;
    if (stick) {
      const knob = stick.querySelector('.dc-knob');
      let origin = null;
      const release = event => {
        if (origin?.id !== event.pointerId) return;
        origin = null;
        this.analog.x = this.analog.y = 0;
        if (knob) knob.style.transform = '';
        stick.classList.remove('active');
      };
      on(stick, 'pointerdown', event => {
        event.preventDefault();
        if (!this.playing) { this.on.requestStart?.(); }
        this.reveal = null;
        origin = { id: event.pointerId, x: event.clientX, y: event.clientY };
        capture(stick, event);
        stick.classList.add('active');
      });
      on(stick, 'pointermove', event => {
        if (origin?.id !== event.pointerId) return;
        const dx = event.clientX - origin.x, dy = event.clientY - origin.y;
        const input = joystickInput(dx, dy);
        this.analog.x = -input.steer;
        this.analog.y = input.throttle;
        const limit = Math.min(1, Math.hypot(dx, dy) / JOYSTICK_RADIUS), angle = Math.atan2(dy, dx);
        if (knob) knob.style.transform = `translate(${Math.cos(angle) * limit * 40}px,${Math.sin(angle) * limit * 40}px)`;
        this.schedule();
      });
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) on(stick, name, release);
    }
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    on(motion, 'change', event => { this.calm = event.matches; this.schedule(); });
  }

  observe() {
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(this.host);
    const apply = visible => {
      this.visible = visible;
      if (visible) { this.lastTime = 0; if (!this.paused) this.audio?.resume(); this.schedule(); }
      else { cancelAnimationFrame(this.frame); this.frame = 0; this.clearInput(); this.audio?.suspend(); }
    };
    this.intersection = new IntersectionObserver(entries => apply(entries[0].isIntersecting && !document.hidden));
    this.intersection.observe(this.host);
    document.addEventListener('visibilitychange', () => {
      const rect = this.host.getBoundingClientRect();
      apply(!document.hidden && rect.bottom > 0 && rect.top < innerHeight);
    }, this.listen);
    this.renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.paused = true;
      this.host.classList.remove('dc-ready');
      this.on.error?.();
    }, this.listen);
  }

  // ---------- API ----------
  start = () => {
    if (this.disposed) return;
    this.playing = true;
    this.view.yaw = 0;
    this.paused = false;
    this.lastTime = 0;
    this.idle = 0;
    // Uma espiada de 2,5 s no painel do sorteio antes de a câmera assentar no dev (qualquer tecla ou toque pula).
    this.reveal = this.calm ? null : { t: 0 };
    this.audio?.unlock();
    this.version++;
    this.host.focus({ preventScroll: true });
    this.schedule();
  };

  setPaused = paused => {
    this.paused = Boolean(paused);
    if (this.paused) this.audio?.suspend(); else this.audio?.resume();
    this.clearInput();
    this.lastTime = 0;
    this.schedule();
    return this.paused;
  };

  togglePause = () => this.setPaused(!this.paused);

  resetProgress = () => {
    // Recomeçar também tira da pausa: o jogo e o som voltam juntos.
    this.setPaused(false);
    this.progress = initialProgress();
    this.racks = createRacks(MODELS.map(model => model.id));
    for (const art of this.dc.racks.values()) art.setState('off');
    this.carrying = false;
    this.energy = createEnergy();
    this.drinks = createDrinks(this.clock);
    this.freezerStatus = null;
    this.sip = 0;
    this.dc.freezer?.setStock(this.drinks.stock);
    this.dc.dock.setCount(3);
    // A mesa recomeça junto: um deploy pausado não pode render XP num data center zerado.
    this.desk = resetDesk(this.desk);
    this.deployGain = DESK.xp;
    if (this.holdShown) { this.on.hold?.(0); this.holdShown = false; }
    this.game = createProgression();
    this.prizeSeen = false;
    this.missionsDone = 0;
    this.idle = 0;
    this.nudged = false;
    this.dc.prize.setPathVisible(true);
    saveProgress(this.progress);
    this.on.xp?.({ progress: this.progress, gained: 0, leveledUp: false });
    this.on.energy?.(1, false);
    this.emitGame();
    this.emitTurbo();
    this.version++;
    this.refresh();
    this.schedule();
  };

  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.aborter.abort();
    this.resizeObserver?.disconnect();
    this.intersection?.disconnect();
    this.host.querySelectorAll('.dc-float').forEach(span => span.remove());
    this.pointer.remove();
    this.sun.shadow.dispose();
    this.dc.release();
    this.kit.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.host.classList.remove('dc-ready');
  };
}

export function createWorld(host, options) {
  const world = new DataCafeWorld(host, options);
  return {
    start: world.start,
    setPaused: world.setPaused,
    togglePause: world.togglePause,
    holdStart: world.holdStart,
    holdEnd: world.holdEnd,
    resetProgress: world.resetProgress,
    seePrize: () => world.seePrize(),
    dispose: world.dispose,
    get playing() { return world.playing; },
    get paused() { return world.paused; },
  };
}
