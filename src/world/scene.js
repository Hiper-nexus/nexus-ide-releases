import * as THREE from 'three';
import { makeWorld, makeRover, makeBarrels, makeProps, ANIMATED, COLORS } from './objects.js';
import { drive, initialVehicle } from './driving.js';
import { collectNearby } from './movement.js';
import { hitBarrel, detonateBarrel, stepBarrels, stepProps, pushProp, blastImpulse, BLAST_RADIUS } from './props.js';
import { XP_AWARD } from './quests.js';
import { WORLD, OBSTACLES } from './layout.js';
import { chaseStep, initialCamera } from './camera.js';
import { joystickInput } from './touch.js';

const KEYS={w:'forward',ArrowUp:'forward',s:'back',ArrowDown:'back',a:'left',ArrowLeft:'left',d:'right',ArrowRight:'right',Shift:'boost',' ':'brake'};
const TERRAIN={ramps:WORLD.ramps,boostPads:WORLD.boostPads};
const STATION_RANGE=3.8;
const SPARK=[new THREE.Color(COLORS.amber),new THREE.Color(COLORS.orange),new THREE.Color(COLORS.pink)];
const PICKUP=[new THREE.Color(COLORS.mint),new THREE.Color(COLORS.orange)];
const DUST=[new THREE.Color(0xd9a4a2),new THREE.Color(0xb98486)];
const FLAME=[new THREE.Color(COLORS.amber),new THREE.Color(COLORS.pink)];

class Particles {
  constructor(scene,capacity){
    this.capacity=capacity;
    this.mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(.16,.16,.16),new THREE.MeshBasicMaterial({toneMapped:false}),capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled=false;
    this.items=Array.from({length:capacity},()=>({ttl:1,life:0,x:0,y:0,z:0,vx:0,vy:0,vz:0}));
    this.dummy=new THREE.Object3D();
    this.cursor=0;
    scene.add(this.mesh);
    const hidden=new THREE.Matrix4().makeScale(0,0,0);
    for(let i=0;i<capacity;i++)this.mesh.setMatrixAt(i,hidden);
  }
  spawn(x,y,z,{count,colors,speed=6,spread=1}){
    for(let i=0;i<count;i++){
      const item=this.items[this.cursor];
      const angle=Math.random()*Math.PI*2;
      const tilt=Math.random()*speed;
      item.ttl=item.life=.45+Math.random()*.55;
      item.x=x;item.y=y;item.z=z;
      item.vx=Math.cos(angle)*tilt*spread;
      item.vz=Math.sin(angle)*tilt*spread;
      item.vy=2+Math.random()*speed;
      this.mesh.setColorAt(this.cursor,colors[i%colors.length]);
      this.cursor=(this.cursor+1)%this.capacity;
    }
    if(this.mesh.instanceColor)this.mesh.instanceColor.needsUpdate=true;
  }
  update(delta){
    let active=false;
    for(let i=0;i<this.capacity;i++){
      const item=this.items[i];
      if(item.life<=0)continue;
      active=true;
      item.life-=delta;
      if(item.life<=0){this.dummy.position.set(0,-5,0);this.dummy.scale.setScalar(0);}
      else{
        item.vy-=13*delta;
        item.x+=item.vx*delta;item.y+=item.vy*delta;item.z+=item.vz*delta;
        if(item.y<.08){item.y=.08;item.vy*=-.35;item.vx*=.7;item.vz*=.7;}
        this.dummy.position.set(item.x,item.y,item.z);
        this.dummy.scale.setScalar(item.life/item.ttl);
        this.dummy.rotation.set(item.life*7,item.life*5,0);
      }
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i,this.dummy.matrix);
    }
    if(active)this.mesh.instanceMatrix.needsUpdate=true;
    return active;
  }
}

class Shockwaves {
  constructor(scene,count=4){
    this.rings=Array.from({length:count},()=>{
      const mesh=new THREE.Mesh(new THREE.RingGeometry(.7,.92,40),new THREE.MeshBasicMaterial({color:0xffc98a,transparent:true,opacity:0,side:THREE.DoubleSide,depthWrite:false,toneMapped:false}));
      mesh.rotation.x=-Math.PI/2;
      mesh.visible=false;
      scene.add(mesh);
      return {mesh,t:1};
    });
  }
  trigger(x,z){
    const ring=this.rings.find(entry=>!entry.mesh.visible)??this.rings[0];
    ring.t=0;
    ring.mesh.position.set(x,.12,z);
    ring.mesh.visible=true;
  }
  update(delta){
    let active=false;
    for(const ring of this.rings){
      if(!ring.mesh.visible)continue;
      ring.t+=delta*2;
      if(ring.t>=1){ring.mesh.visible=false;continue;}
      active=true;
      const scale=1+ring.t*9;
      ring.mesh.scale.set(scale,scale,1);
      ring.mesh.material.opacity=.85*(1-ring.t);
    }
    return active;
  }
}

/** Skid marks left by the rear wheels while drifting. A ring buffer of flat quads. */
class TireMarks {
  constructor(scene,capacity=320){
    this.capacity=capacity;this.cursor=0;this.dummy=new THREE.Object3D();
    this.mesh=new THREE.InstancedMesh(new THREE.PlaneGeometry(.2,.9),new THREE.MeshBasicMaterial({color:0x1b1519,transparent:true,opacity:.28,depthWrite:false}),capacity);
    this.mesh.frustumCulled=false;
    const hidden=new THREE.Matrix4().makeScale(0,0,0);
    for(let i=0;i<capacity;i++)this.mesh.setMatrixAt(i,hidden);
    scene.add(this.mesh);
  }
  stamp(x,z,heading){
    for(const side of [-.72,.72]){
      this.dummy.position.set(x+Math.cos(heading)*side,.02,z-Math.sin(heading)*side);
      this.dummy.rotation.set(-Math.PI/2,0,heading);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(this.cursor,this.dummy.matrix);
      this.cursor=(this.cursor+1)%this.capacity;
    }
    this.mesh.instanceMatrix.needsUpdate=true;
  }
}

class CafeWorld {
  constructor(host,options){
    this.host=host;this.options=options;this.calm=Boolean(options.reducedMotion);
    this.keys=new Set();this.analog={throttle:0,steer:0};this.collected=new Set(options.collected??[]);
    this.vehicle=initialVehicle();this.cam=initialCamera(this.vehicle);this.orbit=0;this.dragging=null;this.focus=null;this.focusUntil=0;
    this.playing=false;this.paused=this.calm;this.visible=true;this.frame=0;this.lastTime=0;this.disposed=false;this.near=null;
    this.wheelRotation=0;this.tiltPitch=0;this.tiltRoll=0;this.bounce=0;this.bounceV=0;this.wasAirborne=false;this.shake=0;this.markTimer=0;this.slowFrames=0;this.lastSpeed=null;this.lastBoost=1;
    const mobile=Math.min(innerWidth,innerHeight)<760;
    this.renderer=new THREE.WebGLRenderer({antialias:!mobile,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,mobile?1.25:1.6));
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFShadowMap;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.05;
    this.renderer.setClearColor(COLORS.skyHorizon);
    host.prepend(this.renderer.domElement);
    this.scene=new THREE.Scene();this.scene.fog=new THREE.Fog(COLORS.fog,48,150);
    this.camera=new THREE.PerspectiveCamera(52,1,.1,300);
    this.scene.add(new THREE.HemisphereLight(0xffc4d4,0x5a2a40,1.5));
    const sun=new THREE.DirectionalLight(0xffcfa6,2.6);sun.castShadow=true;sun.shadow.mapSize.set(mobile?1024:2048,mobile?1024:2048);
    Object.assign(sun.shadow.camera,{left:-36,right:36,top:36,bottom:-36,near:1,far:140});sun.shadow.bias=-.0008;sun.shadow.normalBias=.03;
    this.sun=sun;this.scene.add(sun,sun.target);
    const rim=new THREE.DirectionalLight(0xff6f91,.9);rim.position.set(-30,12,-40);this.scene.add(rim);
    this.flash=new THREE.PointLight(0xffb35c,0,18,1.8);this.flash.position.set(0,2,0);this.scene.add(this.flash);
    this.world=makeWorld(this.scene);this.rover=makeRover(this.scene);
    this.barrels=makeBarrels(this.scene);this.props=makeProps(this.scene);
    this.particles=new Particles(this.scene,this.calm?120:320);this.shockwaves=new Shockwaves(this.scene);this.tireMarks=new TireMarks(this.scene);
    this.scratch=new THREE.Vector3();this.shakeOffset=new THREE.Vector3();
    for(const coffee of this.world.coffees) coffee.mesh.visible=!this.collected.has(coffee.id);
    this.markers=this.world.stations.map(station=>{const button=document.createElement('button');button.className='station-marker';button.textContent=station.label;button.type='button';button.addEventListener('click',()=>this.activate(station));host.append(button);return {...station,button};});
    this.placeRover();
    this.bindInput();this.observe();this.resize();host.classList.add('world-ready');document.querySelector('#world-loading').hidden=true;
  }
  resize=()=>{
    const {clientWidth:w,clientHeight:h}=this.host;
    this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h);this.schedule();
  };
  schedule=()=>{if(!this.frame&&this.visible&&!this.disposed)this.frame=requestAnimationFrame(this.render);};
  render=(time)=>{
    this.frame=0;const raw=(time-this.lastTime)/1000;const delta=Math.min(raw,.05);this.lastTime=time;
    const seconds=time*.001;
    ANIMATED.pulse.forEach((material,index)=>material.emissiveIntensity=.4+.3*Math.sin(seconds*2.2+index*1.9));
    ANIMATED.blink.forEach((material,index)=>material.emissiveIntensity=(seconds*(.7+index*.35)%1)<.62?1.15:.06);
    let effects=false;
    if(!this.paused){
      if(this.playing)this.step(delta);
      for(const coffee of this.world.coffees){coffee.mesh.position.y=.2+Math.sin(seconds*1.8+coffee.id)*.12;coffee.mesh.rotation.y=seconds*.35+coffee.id;}
      effects=this.particles.update(delta)||effects;
      effects=this.shockwaves.update(delta)||effects;
      if(this.flash.intensity>0){this.flash.intensity*=Math.exp(-9*delta);if(this.flash.intensity<.3)this.flash.intensity=0;effects=true;}
      if(!this.dragging&&this.orbit)this.orbit*=Math.exp(-1.8*delta);
      const boosting=this.keys.has('boost')&&this.vehicle.boostCharge>0&&Math.abs(this.vehicle.speed)>1;
      this.cam=chaseStep(this.cam,this.vehicle,delta,{orbit:this.orbit,boost:boosting,attract:!this.playing});
      if(this.focus&&time<this.focusUntil){const k=1-Math.exp(-delta*3);this.cam.tx+=(this.focus.x-this.cam.tx)*k;this.cam.tz+=(this.focus.z-this.cam.tz)*k;this.cam.ty+=(this.focus.y-this.cam.ty)*k;}else this.focus=null;
    }
    this.camera.position.set(this.cam.x,this.cam.y,this.cam.z);
    this.camera.lookAt(this.cam.tx,this.cam.ty,this.cam.tz);
    if(Math.abs(this.camera.fov-this.cam.fov)>.02){this.camera.fov=this.cam.fov;this.camera.updateProjectionMatrix();}
    this.sun.position.set(this.vehicle.x-26,42,this.vehicle.z+18);this.sun.target.position.set(this.vehicle.x,0,this.vehicle.z);
    if(this.shake>0&&!this.calm){
      const s=this.shake*.35;
      this.shakeOffset.set((Math.random()-.5)*s,(Math.random()-.5)*s,(Math.random()-.5)*s);
      this.camera.position.add(this.shakeOffset);
      this.renderer.render(this.scene,this.camera);
      this.shake*=Math.exp(-3.5*delta);
    }else this.renderer.render(this.scene,this.camera);
    for(const marker of this.markers){
      const point=this.scratch.copy(marker.anchor).project(this.camera);
      marker.button.hidden=!this.playing||point.z>1||Math.abs(point.x)>1.05||Math.abs(point.y)>1.05;
      if(!marker.button.hidden)marker.button.style.transform=`translate(${(point.x*.5+.5)*this.host.clientWidth}px,${(-point.y*.5+.5)*this.host.clientHeight}px) translate(-50%,-50%)`;
    }
    // Slow devices drop to a lower pixel ratio instead of dropping frames.
    if(raw>.034&&this.renderer.getPixelRatio()>1){if(++this.slowFrames>45){this.renderer.setPixelRatio(1);this.resize();}}else this.slowFrames=Math.max(0,this.slowFrames-1);
    const moving=Math.abs(this.vehicle.speed)>.01||Math.abs(this.vehicle.vy)>0||this.vehicle.y>0;
    if(!this.paused||this.keys.size||moving||effects||this.dragging)this.schedule();
  };
  input(){
    const throttle=this.keys.has('forward')?1:this.keys.has('back')?-1:this.analog.throttle;
    const steer=this.keys.has('left')?1:this.keys.has('right')?-1:this.analog.steer;
    return {throttle,steer,boost:this.keys.has('boost'),handbrake:this.keys.has('brake')};
  }
  placeRover(){
    const v=this.vehicle,rover=this.rover;
    rover.group.position.set(v.x,v.y,v.z);rover.group.rotation.y=v.heading+Math.PI;
    for(const pivot of rover.fronts)pivot.rotation.y=v.steer*.42;
    rover.chassis.position.y=this.bounce;rover.chassis.rotation.x=this.tiltPitch;rover.chassis.rotation.z=this.tiltRoll;
  }
  step=(delta)=>{
    const input=this.input();
    const before=this.vehicle;
    this.vehicle=drive(before,input,delta,OBSTACLES,TERRAIN);
    const v=this.vehicle,rover=this.rover;
    const airborne=v.y>.03;
    const speed=Math.hypot(v.vx,v.vz);
    const lateral=v.vx*Math.cos(v.heading)-v.vz*Math.sin(v.heading);
    // Suspension: a spring on the chassis that reacts to landings and throttle.
    if(this.wasAirborne&&!airborne)this.bounceV-=Math.min(3.5,before.vy?Math.abs(before.vy)*.35:1.2);
    this.bounceV+=(-this.bounce*70-this.bounceV*9)*delta;this.bounce+=this.bounceV*delta;
    this.wasAirborne=airborne;
    this.wheelRotation-=(v.speed/.32)*delta;
    for(const wheel of rover.wheels)wheel.rotation.x=this.wheelRotation;
    const pitchGoal=airborne?-.12:-input.throttle*.05;
    this.tiltPitch+=(pitchGoal-this.tiltPitch)*Math.min(1,8*delta);
    this.tiltRoll+=((-lateral*.045-v.steer*Math.min(1,speed/6)*.06)-this.tiltRoll)*Math.min(1,8*delta);
    this.placeRover();
    const braking=input.handbrake||(input.throttle<0&&v.speed>.2);
    rover.brakeMaterial.emissiveIntensity=braking?1.8:.25;
    const boosting=input.boost&&v.boostCharge>0&&v.speed>1;
    rover.exhaust.material.opacity=boosting?.75+Math.random()*.25:0;rover.exhaust.scale.setScalar(boosting?1+Math.random()*.3:1);
    rover.headlight.intensity=this.playing?38:0;
    if(boosting&&!this.calm&&Math.random()<.6)this.particles.spawn(v.x+Math.sin(v.heading)*1.2,.5,v.z+Math.cos(v.heading)*1.2,{count:2,colors:FLAME,speed:2,spread:.3});
    const drifting=Math.abs(lateral)>1.6&&speed>3&&!airborne;
    if(drifting){this.markTimer-=delta;if(this.markTimer<=0){this.tireMarks.stamp(v.x,v.z,v.heading);this.markTimer=.05;}if(!this.calm&&Math.random()<.5)this.particles.spawn(v.x,.2,v.z,{count:2,colors:DUST,speed:1.5,spread:.6});}
    Object.assign(this.host.dataset,{playerX:v.x.toFixed(2),playerZ:v.z.toFixed(2),playerHeading:v.heading.toFixed(2),speed:Math.abs(v.speed).toFixed(1)});
    const shown=Math.abs(v.speed).toFixed(1);if(this.lastSpeed!==shown){this.lastSpeed=shown;this.options.onSpeed?.(shown);}
    if(Math.abs(v.boostCharge-this.lastBoost)>.02){this.lastBoost=v.boostCharge;this.options.onBoost?.(v.boostCharge);}
    if(airborne&&!before.y)this.options.onJump?.();
    for(const id of collectNearby(v,this.world.coffees,this.collected)){
      this.collected.add(id);
      const coffee=this.world.coffees[id];
      coffee.mesh.visible=false;
      this.particles.spawn(coffee.x,.6,coffee.z,{count:this.calm?8:22,colors:PICKUP,speed:3,spread:.6});
      this.options.onCoffee(id);
      this.xpFloat(`+${XP_AWARD.coffee} XP`);
    }
    if(speed>.5)this.props=this.props.map(prop=>Math.hypot(prop.x-v.x,prop.z-v.z)<1.05?pushProp(prop,v.x,v.z,Math.max(1.5,speed*.9)):prop);
    this.props=stepProps(this.props,delta);
    for(const prop of this.props){prop.mesh.position.set(prop.x,0,prop.z);if(prop.kind==='pin'){const moving=Math.hypot(prop.vx,prop.vz);prop.mesh.rotation.z=Math.min(Math.PI/2,prop.mesh.rotation.z+(moving>.3?delta*6:0));}}
    this.barrels=stepBarrels(this.barrels,delta);
    const hit=hitBarrel(v,this.barrels);
    if(hit!=null){
      const barrel=this.barrels.find(entry=>entry.id===hit);
      this.barrels=detonateBarrel(this.barrels,hit);
      this.explode(barrel.x,barrel.z);
      const impulse=blastImpulse(v,barrel,8);
      this.vehicle={...v,vx:v.vx+impulse.vx,vz:v.vz+impulse.vz};
      this.props=this.props.map(prop=>Math.hypot(prop.x-barrel.x,prop.z-barrel.z)<BLAST_RADIUS?pushProp(prop,barrel.x,barrel.z,(1-Math.hypot(prop.x-barrel.x,prop.z-barrel.z)/BLAST_RADIUS)*9):prop);
      this.options.onBoom?.();
      this.options.onBarrel?.(hit);
      this.xpFloat(`+${XP_AWARD.barrel} XP`);
    }
    for(const barrel of this.barrels)barrel.mesh.visible=barrel.alive;
    const nearby=this.world.stations.find(s=>Math.hypot(v.x-s.x,v.z-s.z)<STATION_RANGE+2.2);
    if((nearby?.key??null)!==this.near){this.near=nearby?.key??null;this.options.onNear(this.near);}
  };
  explode=(x,z)=>{
    this.particles.spawn(x,.9,z,{count:this.calm?36:120,colors:SPARK,speed:8,spread:1});
    this.shockwaves.trigger(x,z);
    if(!this.calm){this.shake=1;this.flash.position.set(x,2.2,z);this.flash.intensity=30;}
  };
  xpFloat=(text)=>{
    const span=document.createElement('span');
    span.className='xp-float pixel';
    span.textContent=text;
    const point=this.scratch.set(this.vehicle.x,1.6,this.vehicle.z).project(this.camera);
    span.style.left=`${(point.x*.5+.5)*this.host.clientWidth}px`;
    span.style.top=`${(-point.y*.5+.5)*this.host.clientHeight}px`;
    this.host.append(span);
    setTimeout(()=>span.remove(),1100);
  };
  activate=(station)=>{
    const near=Math.hypot(this.vehicle.x-station.x,this.vehicle.z-station.z)<STATION_RANGE+2.2;
    if(near&&!this.paused){
      this.particles.spawn(station.x,2,station.z,{count:this.calm?14:40,colors:[new THREE.Color(COLORS.pink),new THREE.Color(COLORS.white)],speed:4,spread:1});
      this.xpFloat(`+${XP_AWARD.station} XP`);
      this.focus={x:station.x,y:station.anchorY*.5,z:station.z};this.focusUntil=performance.now()+1800;
    }
    this.options.onStation(station.key,near);
  };
  interact=()=>{const station=this.world.stations.find(s=>s.key===this.near);if(station)this.activate(station);};
  keydown=(event)=>{
    if(event.target!==this.host)return;
    const key=event.key.length===1?event.key.toLowerCase():event.key;
    if(key==='Escape'){this.keys.clear();this.host.blur();return;}
    if(key==='e'||key==='Enter'){event.preventDefault();this.interact();return;}
    if(key==='r'){this.reset();return;}
    if(key==='m'){this.options.onMissions?.();return;}
    if(!KEYS[key]||!this.playing)return;event.preventDefault();const fresh=!this.keys.has(KEYS[key]);this.keys.add(KEYS[key]);if(fresh&&!this.paused)this.step(.05);this.schedule();
  };
  keyup=(event)=>{this.keys.delete(KEYS[event.key.length===1?event.key.toLowerCase():event.key]);};
  clearKeys=()=>{this.keys.clear();this.analog={throttle:0,steer:0};};
  bindInput(){
    const canvas=this.renderer.domElement;
    canvas.style.touchAction='none';
    this.host.addEventListener('keydown',this.keydown);window.addEventListener('keyup',this.keyup);window.addEventListener('blur',this.clearKeys);
    // Dragging the scene orbits the camera around the rover; it eases back when released.
    canvas.addEventListener('pointerdown',event=>{this.host.focus({preventScroll:true});this.dragging={id:event.pointerId,x:event.clientX};canvas.setPointerCapture(event.pointerId);});
    canvas.addEventListener('pointermove',event=>{if(this.dragging?.id!==event.pointerId)return;this.orbit+=(event.clientX-this.dragging.x)*-.008;this.dragging.x=event.clientX;this.schedule();});
    for(const name of ['pointerup','pointercancel'])canvas.addEventListener(name,event=>{if(this.dragging?.id===event.pointerId)this.dragging=null;this.schedule();});
    const stick=this.host.querySelector('.joystick');
    if(stick){
      const knob=stick.querySelector('.joystick-knob');let origin=null;
      const move=(event)=>{if(origin?.id!==event.pointerId)return;const dx=event.clientX-origin.x,dy=event.clientY-origin.y;this.analog=joystickInput(dx,dy);const limit=Math.min(1,Math.hypot(dx,dy)/56);const angle=Math.atan2(dy,dx);knob.style.transform=`translate(${Math.cos(angle)*limit*40}px,${Math.sin(angle)*limit*40}px)`;this.schedule();};
      stick.addEventListener('pointerdown',event=>{event.preventDefault();origin={id:event.pointerId,x:event.clientX,y:event.clientY};stick.setPointerCapture(event.pointerId);stick.classList.add('active');if(!this.playing)this.options.onTouchStart?.();});
      stick.addEventListener('pointermove',move);
      for(const name of ['pointerup','pointercancel','lostpointercapture'])stick.addEventListener(name,event=>{if(origin?.id!==event.pointerId)return;origin=null;this.analog={throttle:0,steer:0};knob.style.transform='';stick.classList.remove('active');});
    }
    document.querySelectorAll('[data-action]').forEach(button=>{const action=button.dataset.action;button.addEventListener('pointerdown',event=>{event.preventDefault();this.keys.add(action);button.setPointerCapture(event.pointerId);this.schedule();});for(const name of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(name,()=>this.keys.delete(action));});
  }
  observe(){
    this.resizeObserver=new ResizeObserver(this.resize);this.resizeObserver.observe(this.host);
    this.observer=new IntersectionObserver(entries=>{this.visible=entries[0].isIntersecting&&!document.hidden;if(this.visible)this.schedule();else{cancelAnimationFrame(this.frame);this.frame=0;this.clearKeys();}});this.observer.observe(this.host);
    this.visibility=()=>{this.visible=!document.hidden&&this.host.getBoundingClientRect().bottom>0;if(this.visible)this.schedule();else{cancelAnimationFrame(this.frame);this.frame=0;this.clearKeys();}};document.addEventListener('visibilitychange',this.visibility);
    this.renderer.domElement.addEventListener('webglcontextlost',event=>{event.preventDefault();this.paused=true;this.host.classList.remove('world-ready');this.options.onError?.();});
  }
  start=()=>{this.playing=true;this.paused=false;this.reset();this.host.focus({preventScroll:true});};
  reset=()=>{this.vehicle=initialVehicle();this.cam=initialCamera(this.vehicle);this.orbit=0;this.bounce=0;this.bounceV=0;this.keys.clear();this.analog={throttle:0,steer:0};this.placeRover();this.schedule();};
  togglePause=()=>{this.paused=!this.paused;this.clearKeys();this.vehicle={...this.vehicle,vx:0,vz:0,speed:0};this.schedule();return this.paused;};
  dispose=()=>{this.disposed=true;cancelAnimationFrame(this.frame);this.resizeObserver.disconnect();this.observer.disconnect();this.renderer.dispose();this.host.removeEventListener('keydown',this.keydown);window.removeEventListener('keyup',this.keyup);window.removeEventListener('blur',this.clearKeys);document.removeEventListener('visibilitychange',this.visibility);this.scene.traverse(object=>object.geometry?.dispose());};
}
export function createWorld(host,options){return new CafeWorld(host,options);}
