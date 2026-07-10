export function validateBuildNodeVersion(version) {
  const match = String(version).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 22 && minor >= 12;
}

if (!validateBuildNodeVersion(process.versions.node)) {
  console.error(
    [
      `NexusIDE release builds require Node >=22.12.0 <23. Current Node: ${process.version}.`,
      'Use the pinned Node/npm toolchain from package.json before package/make.',
    ].join('\n'),
  );
  process.exit(1);
}
