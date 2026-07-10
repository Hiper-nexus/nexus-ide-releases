let outputDeviceId = 'default';

export function setRuntimeOutputDeviceId(deviceId: string): void {
  outputDeviceId = deviceId || 'default';
}

export function getRuntimeOutputDeviceId(): string {
  return outputDeviceId;
}
