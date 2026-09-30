import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeWorld, makeRover } from './objects.js';
import { drive, initialVehicle } from './driving.js';
import { collectNearby } from './movement.js';

const KEYS={w:'forward',ArrowUp:'forward',s:'back',ArrowDown:'back',a:'left',ArrowLeft:'left',d:'right',ArrowRight:'right',Shift:'boost'};
const TOUCH={up:'forward',down:'back',left:'left',right:'right'};
const OBSTACLES=[{x:-5,z:-2,width:6,depth:3.3},{x:-7,z:-8,width:8,depth:1},{x:-8,z:6,width:2.4,depth:2.4},{x:8,z:4,width:2.4,depth:2.4},{x:6,z:-7.5,width:4,depth:1.2}];

class CafeWorld {
  constructor(host,options){
    this.host=host;this.options=options;this.keys=new Set();this.collected=new Set(options.collected??[]);this.vehicle=initialVehicle();this.playing=false;this.paused=options.reducedMotion;this.visible=true;this.frame=0;this.lastTime=0;this.disposed=false;this.near=null;
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFShadowMap;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.3;host.prepend(this.renderer.domElement);
    this.scene=new THREE.Scene();this.camera=new THREE.OrthographicCamera(-22,22,15,-15,.1,120);this.camera.position.set(26,30,34);
    this.scene.add(new THREE.HemisphereLight(0xfaf0e8,0x46404c,2.7));const sun=new THREE.DirectionalLight(0xffe4d5,3.5);sun.position.set(-8,20,8);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-22,right:22,top:22,bottom:-22});sun.shadow.bias=-.001;this.scene.add(sun);const fill=new THREE.DirectionalLight(0xd4dcff,1.4);fill.position.set(10,8,-8);this.scene.add(fill);
    this.world=makeWorld(this.scene);this.rover=makeRover(this.scene);this.rover.position.set(0,0,9);
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
    if(this.playing&&!this.paused){this.step(delta);const target=new THREE.Vector3(this.vehicle.x,0,this.vehicle.z-1);const shift=target.sub(this.controls.target).multiplyScalar(.045);this.controls.target.add(shift);this.camera.position.add(shift);}
    if(!this.paused)for(const coffee of this.world.coffees){coffee.mesh.position.y=.2+Math.sin(time*.0018+coffee.id)*.12;coffee.mesh.rotation.y=time*.00035+coffee.id;}
    const changed=this.controls.update();this.renderer.render(this.scene,this.camera);
    for(const marker of this.markers){const point=marker.anchor.clone().project(this.camera);marker.button.style.transform=`translate(${(point.x*.5+.5)*this.host.clientWidth}px,${(-point.y*.5+.5)*this.host.clientHeight}px) translate(-50%,-50%)`;marker.button.hidden=Math.abs(point.x)>1.15||Math.abs(point.y)>1.15;}
    if(!this.paused||this.keys.size||Math.abs(this.vehicle.speed)>.01||changed)this.schedule();
  };
  step=(delta)=>{
    this.vehicle=drive(this.vehicle,{throttle:(this.keys.has('forward')?1:0)-(this.keys.has('back')?1:0),steer:(this.keys.has('left')?1:0)-(this.keys.has('right')?1:0),boost:this.keys.has('boost')},delta,OBSTACLES);
    this.rover.position.set(this.vehicle.x,0,this.vehicle.z);this.rover.rotation.y=this.vehicle.heading+Math.PI;
    Object.assign(this.host.dataset,{playerX:this.vehicle.x.toFixed(2),playerZ:this.vehicle.z.toFixed(2),speed:Math.abs(this.vehicle.speed).toFixed(1)});
    const speed=Math.abs(this.vehicle.speed).toFixed(1);if(this.lastSpeed!==speed){this.lastSpeed=speed;this.options.onSpeed?.(speed);}
    for(const id of collectNearby(this.vehicle,this.world.coffees,this.collected)){this.collected.add(id);this.world.coffees[id].mesh.visible=false;this.options.onCoffee(id);}
    const nearby=this.world.stations.find(s=>Math.hypot(this.vehicle.x-s.mesh.position.x,this.vehicle.z-s.mesh.position.z)<3);
    if((nearby?.key??null)!==this.near){this.near=nearby?.key??null;this.options.onNear(this.near);}
  };
  activate=(station)=>{const near=Math.hypot(this.vehicle.x-station.mesh.position.x,this.vehicle.z-station.mesh.position.z)<3;this.options.onStation(station.key,near);};
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
  reset=()=>{this.vehicle=initialVehicle();this.rover.position.set(0,0,9);this.keys.clear();this.controls.target.set(0,0,7);this.camera.position.set(18,22,29);this.resize();this.schedule();};
  togglePause=()=>{this.paused=!this.paused;this.keys.clear();this.vehicle={...this.vehicle,speed:0};this.schedule();return this.paused;};
  dispose=()=>{this.disposed=true;cancelAnimationFrame(this.frame);this.resizeObserver.disconnect();this.observer.disconnect();this.controls.dispose();this.renderer.dispose();this.host.removeEventListener('keydown',this.keydown);window.removeEventListener('keyup',this.keyup);window.removeEventListener('blur',this.clearKeys);document.removeEventListener('visibilitychange',this.visibility);this.scene.traverse(object=>object.geometry?.dispose());};
}
export function createWorld(host,options){return new CafeWorld(host,options);}
