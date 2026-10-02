export function detectPlatform(info = {}) {
  const platform = String(info.platform || '').toLowerCase();
  const ua = String(info.userAgent || '').toLowerCase();
  if (/android|iphone|ipad|ipod/.test(ua) || info.mobile === true || (platform === 'macintel' && info.maxTouchPoints > 1)) return { os: 'mobile', architecture: 'unknown' };
  const os = /windows|win32|win64/.test(platform + ' ' + ua) ? 'windows'
    : /mac/.test(platform + ' ' + ua) ? 'macos' : /linux/.test(platform + ' ' + ua) ? 'linux' : 'unknown';
  const architecture = String(info.architecture || '').toLowerCase();
  const bitness = String(info.bitness || '');
  if (/^(arm|arm64|aarch64)$/.test(architecture)) return { os, architecture: bitness === '32' ? 'arm32' : 'arm64' };
  if (/^(x86|x64|x86_64|amd64)$/.test(architecture)) return { os, architecture: bitness === '32' ? 'x86' : bitness === '64' || architecture !== 'x86' ? 'x64' : 'unknown' };
  if (os === 'linux') {
    if (/aarch64|arm64/.test(ua)) return { os, architecture: 'arm64' };
    if (/x86_64|amd64|x64/.test(ua)) return { os, architecture: 'x64' };
  }
  if (os === 'windows') {
    if (/arm|aarch64/.test(ua)) return { os, architecture: 'arm64' };
    if (/win64|wow64|x64|amd64/.test(ua)) return { os, architecture: 'x64' };
    if (/win32|wow32|i686/.test(ua)) return { os, architecture: 'x86' };
  }
  return { os, architecture: 'unknown' };
}

export function recommendDownload(device, catalog) {
  const supported = (device.os === 'macos' && device.architecture === 'arm64') || (device.os === 'windows' && device.architecture === 'x64');
  const installer = supported && catalog?.[device.os]?.find(item => item.architecture === device.architecture);
  return installer || { url: '#download' };
}

export async function browserPlatform(navigator) {
  const base = { platform: navigator.platform, userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints };
  if (!navigator.userAgentData) return detectPlatform(base);
  try {
    const hints = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'platform']);
    return detectPlatform({ ...base, ...hints, mobile: navigator.userAgentData.mobile });
  } catch {
    return detectPlatform({ ...base, platform: navigator.userAgentData.platform || base.platform, mobile: navigator.userAgentData.mobile });
  }
}
