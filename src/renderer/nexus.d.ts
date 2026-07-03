import type { NexusApi } from '../shared/types';

declare global {
  interface Window {
    nexus: NexusApi;
  }
}

export {};
