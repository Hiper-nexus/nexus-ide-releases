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
import { RIG, clampYaw, clampTarget, rigGoal, rigStep } from './rig.js';
import { joystickInput, JOYSTICK_RADIUS } from './touch.js';
import { ENERGY, createEnergy, energyStep, drink, speedScale, energyLevel } from './energy.js';
import { createRacks, installGpu, reboot, rackStep, rackState, poweredCount, operationalCount, installedIds, allPowered } from './racks.js';
import { ticketsFrom, badgesFor, speedPerk, TICKET_XP } from './tickets.js';
import { createProgression, scoreTicket, progressionStep, closeShift } from './progression.js';
import { dropUnavailable, missionView } from './missions.js';
import { comboLevel, comboMultiplier } from './combo.js';
import { saveProgress, initialProgress } from './progress.js';

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
const label = (text, { duration = 1, blocked = false } = {}) => Object.freeze({ text, duration, blocked });
const modelOf = id => MODELS.find(model => model.id === id);

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

    this.body = { x: LAYOUT.spawn.x, z: LAYOUT.spawn.z, vx: 0, vz: 0, heading: 0, speed: 0 };
    this.walkOut = {};
    this.intent = { x: 0, y: 0 };
    this.direction = { x: 0, z: 0 };
    this.keys = { up: false, down: false, left: false, right: false };
    this.analog = { x: 0, y: 0 };
    this.yaw = 0;
    this.yawTarget = 0;
    this.target = { x: center.x, z: center.z };
    this.goal = {};
    this.cam = rigGoal({ x: center.x, z: center.z + 1 }, 0, {}, 1.2);
    this.scratch = new Vector3();

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
    this.dragging = null;

    this.items = createInteractables();
    this.registerInteractables();
    this.bindInput();
    this.observe();
    this.resize();
    host.classList.add('dc-ready');
    this.refresh();
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
    const board = label('Ver o sorteio do grupo', { duration: 0.3 });
    register(this.items, { id: 'board', x: LAYOUT.board.x + 0.5, z: LAYOUT.board.z + 0.95, radius: 0.95, label: () => board, onComplete: () => this.on.station?.('group') });
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

  award(ticket, what) {
    const before = new Set(this.progress.badges);
    const unavailable = this.unavailableMissions();
    const result = scoreTicket(this.game, this.progress, ticket, undefined, unavailable);
    this.game = { ...result.state, missions: dropUnavailable(result.state.missions, undefined, unavailable) };
    const progress = { ...result.progress, racksOn: installedIds(this.racks) };
    const badges = badgesFor(progress, this.racks);
    this.progress = { ...progress, badges };
    saveProgress(this.progress);
    const mission = result.finished[0];
    this.floatText(`+${result.xpGained + result.bonus} XP`);
    if (mission) this.on.toast?.(`Missão cumprida: ${mission.text} · +${mission.xp} XP`);
    else this.on.toast?.(result.multiplier > 1 ? `${what} · combo ×${result.multiplier} · +${result.xpGained} XP` : `${what} · +${result.xpGained} XP`);
    this.on.xp?.({ progress: this.progress, gained: result.xpGained + result.bonus, leveledUp: result.leveledUp });
    if (result.leveledUp) this.audio?.levelUp();
    else if (mission) this.audio?.mission();
    else if (this.game.combo.streak > 1) this.audio?.combo(this.game.combo.streak);
    this.emitGame();
    for (const badge of badges) if (!before.has(badge)) this.on.badge?.(badge);
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
  }

  advanceGame(dt) {
    const step = progressionStep(this.game, dt);
    this.game = step.state;
    if (step.shiftOver) {
      const closed = closeShift(this.game, this.progress);
      this.game = closed.state;
      this.progress = { ...closed.progress, badges: badgesFor(closed.progress, this.racks) };
      saveProgress(this.progress);
      // Turno sem ponto nenhum fecha calado: ninguém quer um aviso de zero a cada três minutos.
      if (closed.score > 0) {
        this.audio?.shiftEnd();
        this.on.toast?.(closed.record ? `Turno encerrado: ${closed.score} pontos. Recorde novo!` : `Turno encerrado: ${closed.score} pontos. Recorde: ${this.progress.bestShift}.`);
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

  // ---------- Simulação ----------
  simulate(dt) {
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
    worldDirection(this.intent, this.yaw, this.direction);
    const scale = speedScale(this.energy) * speedPerk(this.progress.level) * (this.carrying ? WALK.carryScale : 1);
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
      this.promptItem = item;
      this.promptLabel = current;
      this.on.prompt?.(current);
      this.dc.highlight(item);
      this.blockedToast = false;
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
      this.move(dt);
      this.simulate(dt);
      this.interact(dt);
      if (this.version !== this.shownVersion) this.refresh();
      else this.trackGoal(dt);
    }
    if (running) {
      this.dev.group.position.set(this.body.x, 0, this.body.z);
      this.dev.setMotion({ speed: this.playing ? this.body.speed : 0, heading: this.body.heading, carrying: this.carrying, tired: this.energy.tired, calm: this.calm }, dt);
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
    if (animate || effects || this.dragging) this.schedule();
  };

  updateCamera(dt, seconds) {
    const portrait = this.camera.aspect < 0.9;
    const zoom = this.playing ? (portrait ? 1.3 : 1) : (portrait ? 1.65 : 1.25);
    if (!this.playing && !this.calm && !this.dragging) this.yawTarget = Math.sin(seconds * 0.12) * 0.45;
    this.yaw += (this.yawTarget - this.yaw) * Math.min(1, (this.calm ? 20 : 4) * dt);
    if (this.playing) clampTarget(this.body.x, this.body.z, LAYOUT, this.target);
    else { this.target.x = LAYOUT.width / 2; this.target.z = LAYOUT.height / 2 - 0.5; }
    rigGoal(this.target, this.yaw, this.goal, zoom);
    rigStep(this.cam, this.goal, dt, this.calm ? 40 : RIG.follow);
    this.camera.position.set(this.cam.x, this.cam.y, this.cam.z);
    this.camera.lookAt(this.cam.tx, this.cam.ty, this.cam.tz);
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
    if (key === 'escape') { this.clearInput(); this.host.blur(); return; }
    if (!this.playing || this.paused) return;
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
    this.dragging = null;
  };

  holdStart = () => {
    if (!this.playing || this.paused || this.disposed) return;
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
    on(canvas, 'pointerdown', event => {
      this.host.focus({ preventScroll: true });
      this.dragging = { id: event.pointerId, x: event.clientX };
      capture(canvas, event);
      this.schedule();
    });
    on(canvas, 'pointermove', event => {
      if (this.dragging?.id !== event.pointerId) return;
      this.yawTarget = clampYaw(this.yawTarget - (event.clientX - this.dragging.x) * 0.004);
      this.dragging.x = event.clientX;
      this.schedule();
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) on(canvas, name, event => { if (this.dragging?.id === event.pointerId) this.dragging = null; });
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
    this.yawTarget = 0;
    this.paused = false;
    this.lastTime = 0;
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
    this.progress = initialProgress();
    this.racks = createRacks(MODELS.map(model => model.id));
    for (const art of this.dc.racks.values()) art.setState('off');
    this.carrying = false;
    this.energy = createEnergy();
    this.dc.dock.setCount(3);
    this.game = createProgression();
    saveProgress(this.progress);
    this.on.xp?.({ progress: this.progress, gained: 0, leveledUp: false });
    this.on.energy?.(1, false);
    this.emitGame();
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
    dispose: world.dispose,
    get playing() { return world.playing; },
    get paused() { return world.paused; },
  };
}
