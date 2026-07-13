import { contextBridge, ipcRenderer } from 'electron';
import {
  PET_CHANNELS,
  type NexusPetApi,
  type PetEvent,
  type PetPlacement,
  type PetPrefs,
} from '../shared/pet-types';

/**
 * Preload MÍNIMO da janela do pet: só o contrato do companion — prefs,
 * eventos operacionais, drag e interatividade. Nada do `window.nexus`
 * completo entra aqui: a janela do pet não precisa (nem deve) ver PTYs,
 * arquivos ou orquestração.
 */

const api: NexusPetApi = {
  getPrefs: () => ipcRenderer.invoke(PET_CHANNELS.getPrefs),
  setPrefs: (patch) => ipcRenderer.invoke(PET_CHANNELS.setPrefs, patch),
  onPrefsChanged: (cb) => {
    const listener = (_e: unknown, prefs: PetPrefs) => cb(prefs);
    ipcRenderer.on(PET_CHANNELS.prefsChanged, listener);
    return () => ipcRenderer.removeListener(PET_CHANNELS.prefsChanged, listener);
  },
  onEvent: (cb) => {
    const listener = (_e: unknown, event: PetEvent) => cb(event);
    ipcRenderer.on(PET_CHANNELS.event, listener);
    return () => ipcRenderer.removeListener(PET_CHANNELS.event, listener);
  },
  ready: () => ipcRenderer.send(PET_CHANNELS.rendererReady),
  eventShown: (kind) => ipcRenderer.send(PET_CHANNELS.eventShown, kind),
  onLook: (cb) => {
    const listener = (_e: unknown, dir: number | null) => cb(dir);
    ipcRenderer.on(PET_CHANNELS.look, listener);
    return () => ipcRenderer.removeListener(PET_CHANNELS.look, listener);
  },
  onPlacement: (cb) => {
    const listener = (_e: unknown, placement: PetPlacement) => cb(placement);
    ipcRenderer.on(PET_CHANNELS.placement, listener);
    return () => ipcRenderer.removeListener(PET_CHANNELS.placement, listener);
  },
  setInteractive: (interactive) =>
    ipcRenderer.send(PET_CHANNELS.setInteractive, interactive === true),
  dragBegin: (offset) => ipcRenderer.send(PET_CHANNELS.dragBegin, offset),
  dragEnd: () => ipcRenderer.send(PET_CHANNELS.dragEnd),
  focusMain: () => ipcRenderer.send(PET_CHANNELS.focusMain),
  openSettings: () => ipcRenderer.send(PET_CHANNELS.requestSettings),
  openOps: () => ipcRenderer.send(PET_CHANNELS.requestOpenOps),
};

contextBridge.exposeInMainWorld('nexusPet', api);
