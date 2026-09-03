const o="# >>> BridgeSpace shell integration >>>",a="# <<< BridgeSpace shell integration <<<",m=`${o}
# v3: skip inside the primary BridgeSpace shell (its own integration.zsh
# emits these markers — running both double-emitted every prompt).
# v2: also emits the working directory (OSC 9;9) on every prompt and cd.
# BridgeSpace emits OSC 133 semantic prompt markers so its AI inline
# autocomplete can tell when you are typing vs when a command is
# running, plus OSC 9;9 so suggestions are scoped to the directory you
# are actually in. Safe to delete this block — it only adds
# precmd/preexec/chpwd hooks. Unset BRIDGESPACE_SHELL_INTEGRATION to
# disable at runtime.
if [[ -o interactive && "\${BRIDGESPACE_SHELL_INTEGRATION:-1}" != "0" && -z "\${BRIDGESPACE_INTEGRATION_DIR:-}" ]]; then
  __bridgespace_emit_cwd() { printf '\\e]9;9;%s\\a' "$PWD"; }
  __bridgespace_prompt_start() { __bridgespace_emit_cwd; printf '\\e]133;A\\a'; }
  __bridgespace_command_start() { printf '\\e]133;C\\a'; }
  autoload -Uz add-zsh-hook 2>/dev/null
  if (( \${+functions[add-zsh-hook]} )); then
    add-zsh-hook precmd __bridgespace_prompt_start 2>/dev/null
    add-zsh-hook preexec __bridgespace_command_start 2>/dev/null
    add-zsh-hook chpwd __bridgespace_emit_cwd 2>/dev/null
  fi
fi
${a}`;function _(e,t){const r=e.indexOf(o),n=e.indexOf(a);if(r===-1&&n===-1){const l=e.replace(/\s+$/u,""),p=l.length===0?"":`

`;return`${l}${p}${t}
`}if(r===-1||n===-1||n<r)return e;const s=e.slice(0,r),f=n+a.length;let i=e.slice(f);i.startsWith(`
`)&&(i=i.slice(1));const c=s.replace(/\s+$/u,""),u=c.length===0?"":`

`,h=i.length===0?`
`:`
${i}`;return`${c}${u}${t}${h}`}function g(e){const t=e.indexOf(o),r=e.indexOf(a);if(t===-1||r===-1||r<t)return e;const n=e.slice(0,t).replace(/\s+$/u,""),s=e.slice(r+a.length).replace(/^\n/u,"");return n.length===0&&s.length===0?"":n.length===0?s:s.length===0?`${n}
`:`${n}

${s}`}async function d(){const e=window.tauriAPI;if(!e?.system?.getHomeDir||!e?.fs?.join)return null;try{const t=await e.system.getHomeDir();return t?await e.fs.join(t,".zshrc"):null}catch{return null}}async function w(){const e=window.tauriAPI;if(!e?.fs?.readFile||!e?.fs?.writeFile)return!1;const t=await d();if(!t)return!1;let r="";try{r=await e.fs.readFile(t)}catch{r=""}const n=_(r,m);if(n===r)return!1;try{return await e.fs.writeFile(t,n),!0}catch(s){return console.warn("[terminal-assist] failed to write zsh shell integration",s),!1}}async function I(){const e=window.tauriAPI;if(!e?.fs?.readFile||!e?.fs?.writeFile)return!1;const t=await d();if(!t)return!1;let r;try{r=await e.fs.readFile(t)}catch{return!1}const n=g(r);if(n===r)return!1;try{return await e.fs.writeFile(t,n),!0}catch(s){return console.warn("[terminal-assist] failed to remove zsh shell integration",s),!1}}export{o as MARKER_BEGIN,a as MARKER_END,m as ZSH_TEMPLATE,w as installZshIntegration,g as removeBlock,_ as spliceBlock,I as uninstallZshIntegration};
