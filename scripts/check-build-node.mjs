const major = Number(process.versions.node.split('.')[0]);

if (!Number.isFinite(major) || major < 20 || major >= 23) {
  console.error(
    [
      `NexusIDE release builds require Node 20 or 22. Current Node: ${process.version}.`,
      'Use an LTS toolchain before running package/make.',
      'Example on this machine: PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run make',
    ].join('\n'),
  );
  process.exit(1);
}
