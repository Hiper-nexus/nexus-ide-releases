# Nexus IDE — optional fish OSC 133 shell integration (clean-room).
#   if set -q NEXUS_SHELL_INTEGRATION; source /path/to/nexus-osc133.fish; end

if set -q NEXUS_OSC133_LOADED
  exit 0
end
set -g NEXUS_OSC133_LOADED 1

function __nexus_osc
  printf '\033]%s\007' $argv[1]
end

function __nexus_preexec --on-event fish_preexec
  __nexus_osc "133;B"
  __nexus_osc "133;E;$argv[1]"
  __nexus_osc "133;C"
end

function __nexus_postexec --on-event fish_postexec
  set -l code $status
  __nexus_osc "133;D;$code"
  __nexus_osc "133;A"
  __nexus_osc "133;P;cwd=$PWD"
end
