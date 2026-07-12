import type { NexusPetApi } from '../../shared/pet-types';

declare global {
  interface Window {
    nexusPet: NexusPetApi;
  }
}

export {};
