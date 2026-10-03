import { analysisClient, subscribePtyAnalysis } from '../pty/pty-analysis-runtime';
import { MissionMarkerObserver, type MissionMarkerSighting } from './mission-completion-marker-core';
export * from './mission-completion-marker-core';
class WorkerMissionMarkerObserver extends MissionMarkerObserver {
  override registerPrompt(sessionId: string, prompt: string): void {
    super.registerPrompt(sessionId, prompt);
    analysisClient.control(sessionId, 'completion', { prompt });
  }
  override drop(sessionId: string): void { super.drop(sessionId); analysisClient.control(sessionId, 'completion', { drop: true }); }
}
export const missionMarkerObserver = new WorkerMissionMarkerObserver();
subscribePtyAnalysis('completion', (sessionId, marker) => missionMarkerObserver.accept(sessionId, marker as MissionMarkerSighting));
