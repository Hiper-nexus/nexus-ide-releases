import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeWorld, makeRover, makeBarrels, makeProps, ANIMATED, COLORS } from './objects.js';
import { drive, initialVehicle } from './driving.js';
import { collectNearby } from './movement.js';
import { hitBarrel, detonateBarrel, stepBarrels, stepProps, pushProp, blastImpulse, BLAST_RADIUS } from './props.js';
import { XP_AWARD } from './quests.js';

const KEYS={w:'forward',ArrowUp:'forward',s:'back',ArrowDown:'back',a:'left',ArrowLeft:'left',d:'right',ArrowRight:'right',Shift:'boost',' ':'brake'};
const TOUCH={up:'forward',down:'back',left:'left',right:'right',boost:'boost',brake:'brake'};
const OBSTACLES=[{x:-5,z:-2,width:6,depth:3.3},{x:-7,z:-8,width:8,depth:1},{x:-8,z:6,width:2.4,depth:2.4},{x:8,z:4,width:2.4,depth:2.4},{x:6,z:-7.5,width:4,depth:1.2}];
const SPARK=[new THREE.Color(COLORS.amber),new THREE.Color(COLORS.orange),new THREE.Color(COLORS.pink)];
const PICKUP=[new THREE.Color(COLORS.mint),new THREE.Color(COLORS.orange)];

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

class CafeWorld {
  constructor(host,options){
    this.host=host;this.options=options;this.keys=new Set();this.collected=new Set(options.collected??[]);this.vehicle=initialVehicle();this.playing=false;this.paused=options.reducedMotion;this.visible=true;this.frame=0;this.lastTime=0;this.disposed=false;this.near=null;this.wheelRotation=0;this.tiltPitch=0;this.tiltRoll=0;this.shake=0;this.lastBoost=1;this.calm=options.reducedMotion?1:0;
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFShadowMap;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.3;host.prepend(this.renderer.domElement);
    this.scene=new THREE.Scene();this.camera=new THREE.OrthographicCamera(-22,22,15,-15,.1,120);this.camera.position.set(26,30,34);
    this.scene.add(new THREE.HemisphereLight(0xfaf0e8,0x46404c,2.7));const sun=new THREE.DirectionalLight(0xffe4d5,3.5);sun.position.set(-8,20,8);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-22,right:22,top:22,bottom:-22});sun.shadow.bias=-.001;this.scene.add(sun);const fill=new THREE.DirectionalLight(0xd4dcff,1.4);fill.position.set(10,8,-8);this.scene.add(fill);
    this.flash=new THREE.PointLight(0xffb35c,0,16,1.8);this.flash.position.set(0,2,0);this.scene.add(this.flash);
    this.world=makeWorld(this.scene);this.rover=makeRover(this.scene);this.rover.group.position.set(0,0,9);
    this.barrels=makeBarrels(this.scene);this.props=makeProps(this.scene);
    this.particles=new Particles(this.scene,220);this.shockwaves=new Shockwaves(this.scene);
    this.follow=new THREE.Vector3();this.scratch=new THREE.Vector3();this.shakeOffset=new THREE.Vector3();
    for(const coffee of this.world.coffees) coffee.mesh.visible=!this.collected.has(coffee.id);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);Object.assign(this.controls,{enablePan:false,enableZoom:false,enableDamping:true,dampingFactor:.08,minPolarAngle:.45,maxPolarAngle:1.12});this.renderer.domElement.style.touchAction='pan-y';
    this.markers=this.world.stations.map(station=>{station.mesh.userData.station=station.key;const button=document.createElement('button');button.className='station-marker';button.textContent=station.label+' ↗';button.type='button';button.addEventListener('click',()=>this.activate(station));host.append(button);return {...station,button};});
    this.bindInput();this.observe();this.resize();host.classList.add('world-ready');document.querySelector('#world-loading').hidden=true;
  }
  resize=()=>{
    const {clientWidth:w,clientHeight:h}=this.host;const aspect=w/h;const size=this.playing?(aspect<1?15:11):(aspect<1?23:17);
    Object.assign(this.camera,{left:-size*aspect,right:size*aspect,top:size,bottom:-size});this.camera.updateProjectionMatrix();this.renderer.setSize(w,h);this.schedule();
  };
  schedule=()=>{if(!this.frame&&this.visible&&!this.disposed)this.frame=requestAnimationFrame(this.render);};
  render=(time)=>{
    this.frame=0;const delta=Math.min((time-this.lastTime)/1000,.05);this.lastTime=time;
    const seconds=time*.001;
    ANIMATED.pulse.forEach((material,index)=>material.emissiveIntensity=.34+.26*Math.sin(seconds*2.2+index*1.9));
    ANIMATED.blink.forEach((material,index)=>material.emissiveIntensity=(seconds*(.7+index*.35)%1)<.62?1.15:.06);
    let effects=false;
    if(!this.paused){
      if(this.playing)this.step(delta);
      for(const coffee of this.world.coffees){coffee.mesh.position.y=.2+Math.sin(seconds*1.8+coffee.id)*.12;coffee.mesh.rotation.y=seconds*.35+coffee.id;}
      effects=this.particles.update(delta)||effects;
      effects=this.shockwaves.update(delta)||effects;
      if(this.flash.intensity>0){this.flash.intensity*=Math.exp(-9*delta);if(this.flash.intensity<.3)this.flash.intensity=0;effects=true;}
    }
    const changed=this.controls.update();
    if(this.shake>0&&!this.options.reducedMotion){
      const s=this.shake*.4;
      this.shakeOffset.set((Math.random()-.5)*s,(Math.random()-.5)*s,(Math.random()-.5)*s);
      this.camera.position.add(this.shakeOffset);
      this.renderer.render(this.scene,this.camera);
      this.camera.position.sub(this.shakeOffset);
      this.shake*=Math.exp(-3.5*delta);
    }else this.renderer.render(this.scene,this.camera);
    for(const marker of this.markers){const point=this.scratch.copy(marker.anchor).project(this.camera);marker.button.style.transform=`translate(${(point.x*.5+.5)*this.host.clientWidth}px,${(-point.y*.5+.5)*this.host.clientHeight}px) translate(-50%,-50%)`;marker.button.hidden=Math.abs(point.x)>1.15||Math.abs(point.y)>1.15;}
    if(!this.paused||this.keys.size||Math.abs(this.vehicle.speed)>.01||changed||effects)this.schedule();
  };
  step=(delta)=>{
    const input={throttle:(this.keys.has('forward')?1:0)-(this.keys.has('back')?1:0),steer:(this.keys.has('left')?1:0)-(this.keys.has('right')?1:0),boost:this.keys.has('boost'),handbrake:this.keys.has('brake')};
    this.vehicle=drive(this.vehicle,input,delta,OBSTACLES);
    const rover=this.rover;
    rover.group.position.set(this.vehicle.x,0,this.vehicle.z);
    rover.group.rotation.y=this.vehicle.heading+Math.PI;
    this.wheelRotation-=(this.vehicle.speed/.32)*delta;
    for(const wheel of rover.wheels)wheel.rotation.x=this.wheelRotation;
    for(const pivot of rover.fronts)pivot.rotation.y=this.vehicle.steer*.42;
    this.tiltPitch+=((-input.throttle*.05)-this.tiltPitch)*Math.min(1,8*delta);
    this.tiltRoll+=((-this.vehicle.steer*Math.min(1,Math.abs(this.vehicle.speed)/6)*.09)-this.tiltRoll)*Math.min(1,8*delta);
    rover.chassis.rotation.x=this.tiltPitch;
    rover.chassis.rotation.z=this.tiltRoll;
    Object.assign(this.host.dataset,{playerX:this.vehicle.x.toFixed(2),playerZ:this.vehicle.z.toFixed(2),speed:Math.abs(this.vehicle.speed).toFixed(1)});
    const speed=Math.abs(this.vehicle.speed).toFixed(1);if(this.lastSpeed!==speed){this.lastSpeed=speed;this.options.onSpeed?.(speed);}
    if(Math.abs(this.vehicle.boostCharge-this.lastBoost)>.02){this.lastBoost=this.vehicle.boostCharge;this.options.onBoost?.(this.vehicle.boostCharge);}
    for(const id of collectNearby(this.vehicle,this.world.coffees,this.collected)){
      this.collected.add(id);
      const coffee=this.world.coffees[id];
      coffee.mesh.visible=false;
      this.particles.spawn(coffee.x,.6,coffee.z,{count:this.calm?8:22,colors:PICKUP,speed:3,spread:.6});
      this.options.onCoffee(id);
      this.xpFloat(`+${XP_AWARD.coffee} XP`);
    }
    const speedNow=Math.hypot(this.vehicle.vx,this.vehicle.vz);
    if(speedNow>.5)this.props=this.props.map(prop=>Math.hypot(prop.x-this.vehicle.x,prop.z-this.vehicle.z)<1?pushProp(prop,this.vehicle.x,this.vehicle.z,Math.max(1.5,speedNow*.9)):prop);
    this.props=stepProps(this.props,delta);
    for(const prop of this.props)prop.mesh.position.set(prop.x,0,prop.z);
    this.barrels=stepBarrels(this.barrels,delta);
    const hit=hitBarrel(this.vehicle,this.barrels);
    if(hit!=null){
      const barrel=this.barrels.find(entry=>entry.id===hit);
      this.barrels=detonateBarrel(this.barrels,hit);
      this.explode(barrel.x,barrel.z);
      const impulse=blastImpulse(this.vehicle,barrel,8);
      this.vehicle={...this.vehicle,vx:this.vehicle.vx+impulse.vx,vz:this.vehicle.vz+impulse.vz};
      this.props=this.props.map(prop=>Math.hypot(prop.x-barrel.x,prop.z-barrel.z)<BLAST_RADIUS?pushProp(prop,barrel.x,barrel.z,(1-Math.hypot(prop.x-barrel.x,prop.z-barrel.z)/BLAST_RADIUS)*9):prop);
      this.options.onBoom?.();
      this.options.onBarrel?.(hit);
      this.xpFloat(`+${XP_AWARD.barrel} XP`);
    }
    for(const barrel of this.barrels)barrel.mesh.visible=barrel.alive;
    const nearby=this.world.stations.find(s=>Math.hypot(this.vehicle.x-s.mesh.position.x,this.vehicle.z-s.mesh.position.z)<3);
    if((nearby?.key??null)!==this.near){this.near=nearby?.key??null;this.options.onNear(this.near);}
  };
  explode=(x,z)=>{
    this.particles.spawn(x,.9,z,{count:this.calm?36:110,colors:SPARK,speed:8,spread:1});
    this.shockwaves.trigger(x,z);
    if(!this.calm){this.shake=1;this.flash.position.set(x,2.2,z);this.flash.intensity=26;}
  };
  xpFloat=(text)=>{
    const span=document.createElement('span');
    span.className='xp-float pixel';
    span.textContent=text;
    const point=this.scratch.set(this.vehicle.x,1.4,this.vehicle.z).project(this.camera);
    span.style.left=`${(point.x*.5+.5)*this.host.clientWidth}px`;
    span.style.top=`${(-point.y*.5+.5)*this.host.clientHeight}px`;
    this.host.append(span);
    setTimeout(()=>span.remove(),1100);
  };
  activate=(station)=>{
    const near=Math.hypot(this.vehicle.x-station.mesh.position.x,this.vehicle.z-station.mesh.position.z)<3;
    if(near&&!this.paused){
      this.particles.spawn(station.mesh.position.x,2,station.mesh.position.z,{count:this.calm?14:36,colors:[new THREE.Color(COLORS.pink),new THREE.Color(COLORS.white)],speed:4,spread:1});
      this.xpFloat(`+${XP_AWARD.station} XP`);
    }
    this.options.onStation(station.key,near);
  };
  interact=()=>{const station=this.world.stations.find(s=>s.key===this.near);if(station)this.activate(station);};
  keydown=(event)=>{
    if(event.target!==this.host)return;
    const key=event.key.length===1?event.key.toLowerCase():event.key;
    if(key==='Escape'){this.keys.clear();this.host.blur();return;}if(key==='e'||key==='Enter'){event.preventDefault();this.interact();return;}if(key==='r'){this.reset();return;}
    if(!KEYS[key]||!this.playing)return;event.preventDefault();const fresh=!this.keys.has(KEYS[key]);this.keys.add(KEYS[key]);if(fresh&&!this.paused)this.step(.08);this.schedule();
  };
  keyup=(event)=>{this.keys.delete(KEYS[event.key.length===1?event.key.toLowerCase():event.key]);};
  clearKeys=()=>{this.keys.clear();};
  bindInput(){
    this.host.addEventListener('keydown',this.keydown);window.addEventListener('keyup',this.keyup);window.addEventListener('blur',this.clearKeys);
    this.renderer.domElement.addEventListener('pointerdown',()=>this.host.focus({preventScroll:true}));this.controls.addEventListener('change',this.schedule);
    document.querySelectorAll('[data-move]').forEach(button=>{const action=TOUCH[button.dataset.move];button.addEventListener('pointerdown',event=>{event.preventDefault();this.keys.add(action);button.setPointerCapture(event.pointerId);if(this.playing&&!this.paused)this.step(.08);this.schedule();});for(const name of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(name,()=>this.keys.delete(action));});
  }
  observe(){
    this.resizeObserver=new ResizeObserver(this.resize);this.resizeObserver.observe(this.host);
    this.observer=new IntersectionObserver(entries=>{this.visible=entries[0].isIntersecting&&!document.hidden;if(this.visible)this.schedule();else{cancelAnimationFrame(this.frame);this.frame=0;this.keys.clear();}});this.observer.observe(this.host);
    this.visibility=()=>{this.visible=!document.hidden&&this.host.getBoundingClientRect().bottom>0;if(this.visible)this.schedule();else{cancelAnimationFrame(this.frame);this.frame=0;this.keys.clear();}};document.addEventListener('visibilitychange',this.visibility);
    this.renderer.domElement.addEventListener('webglcontextlost',event=>{event.preventDefault();this.paused=true;this.host.classList.remove('world-ready');this.options.onError?.();});
  }
  start=()=>{this.playing=true;this.paused=false;this.reset();this.host.focus({preventScroll:true});};
  reset=()=>{this.vehicle=initialVehicle();this.rover.group.position.set(0,0,9);this.keys.clear();this.controls.target.set(0,0,7);this.camera.position.set(18,22,29);this.resize();this.schedule();};
  togglePause=()=>{this.paused=!this.paused;this.keys.clear();this.vehicle={...this.vehicle,vx:0,vz:0,speed:0};this.schedule();return this.paused;};
  dispose=()=>{this.disposed=true;cancelAnimationFrame(this.frame);this.resizeObserver.disconnect();this.observer.disconnect();this.controls.dispose();this.renderer.dispose();this.host.removeEventListener('keydown',this.keydown);window.removeEventListener('keyup',this.keyup);window.removeEventListener('blur',this.clearKeys);document.removeEventListener('visibilitychange',this.visibility);this.scene.traverse(object=>object.geometry?.dispose());};
}
export function createWorld(host,options){return new CafeWorld(host,options);}
