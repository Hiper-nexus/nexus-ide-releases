import{j as e}from"./vendor-markdown-Bdv7O72I.js";import{X as b,a as l,L as m}from"./AuthenticatedShell-B6g16bmQ.js";import{l as f}from"./MainApp-Bsp7gQmz.js";import{cI as F}from"./MainApp-Bsp7gQmz.js";import{D as c}from"./download-DQr1IuTU.js";import"./index-D0sLjlYW.js";import"./vendor-react-aMSrFcz-.js";import"./image-DDPYVuVT.js";import"./AuthConfig-Dhqym88V.js";import"./vendor-codemirror-DGS4eVZj.js";import"./vendor-xterm-core-M9HKtSfx.js";function S({isOpen:d,version:o,isDownloading:t,isDownloaded:r,isInstalling:a=!1,downloadPercent:s,errorMessage:i,onInstall:x,onDismiss:p}){if(!d)return null;const n=o.trim().length>0,u=i&&!n?"Update Failed":"Update Available";return e.jsxs("div",{className:"fixed inset-0 z-50 flex items-center justify-center",children:[e.jsx("div",{className:"absolute inset-0 bg-overlay backdrop-blur-sm cursor-pointer",onClick:p}),e.jsxs("div",{className:"relative z-10 w-full max-w-sm mx-4 max-h-[85vh] overflow-y-auto rounded-lg border border-border bg-surface shadow-2xl",children:[e.jsxs("div",{className:"flex items-center justify-between border-b border-border px-4 py-3",children:[e.jsxs("div",{className:"flex items-center gap-2.5",children:[e.jsx("div",{className:"flex h-8 w-8 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary",children:e.jsx(c,{size:15})}),e.jsxs("div",{children:[e.jsx("h2",{className:"text-sm font-semibold text-text-primary",children:u}),n?e.jsxs("p",{className:"text-[11px] text-text-muted",children:["BridgeSpace v",o]}):null]})]}),e.jsx("button",{onClick:p,className:"rounded-md p-1 text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary",children:e.jsx(b,{size:14})})]}),e.jsxs("div",{className:"px-3 sm:px-4 py-3 sm:py-4",children:[e.jsxs("p",{className:"text-xs text-text-secondary",children:[n?"A new version of BridgeSpace is available.":"BridgeSpace couldn't complete the update.",n?r?" The update has been downloaded and is ready to install.":t?" Downloading the update...":" Would you like to update now?":null]}),t&&!r&&e.jsxs("div",{className:"mt-3",children:[e.jsxs("div",{className:"mb-1 flex items-center justify-between text-[10px] text-text-muted",children:[e.jsx("span",{children:"Downloading..."}),e.jsxs("span",{children:[s,"%"]})]}),e.jsx("div",{className:"h-1.5 w-full overflow-hidden rounded-full bg-surface-hover",children:e.jsx("div",{className:"h-full rounded-full bg-primary transition-all duration-300",style:{width:`${s}%`}})})]}),i?e.jsx("div",{className:"mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger",children:i}):null]}),e.jsxs("div",{className:"flex items-center justify-end gap-2 border-t border-border px-3 sm:px-4 py-3 flex-wrap",children:[e.jsx("button",{onClick:p,className:l("rounded-md border border-border bg-surface-hover px-3 py-1.5","text-xs font-medium text-text-secondary transition-colors hover:text-text-primary hover:border-border-active"),children:"Later"}),n?e.jsx("button",{onClick:x,disabled:a||t&&!r,className:l("inline-flex items-center gap-2 rounded-md border border-primary bg-primary px-3 py-1.5","text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90","disabled:cursor-not-allowed disabled:opacity-60"),children:a?e.jsxs(e.Fragment,{children:[e.jsx(m,{size:13,className:"animate-spin"}),"Installing..."]}):t&&!r?e.jsxs(e.Fragment,{children:[e.jsx(m,{size:13,className:"animate-spin"}),"Downloading..."]}):e.jsxs(e.Fragment,{children:[e.jsx(c,{size:13}),r?"Install and Restart":"Update Now"]})}):null]})]})]})}function X({isBackgroundDownloading:d,isUpdateAvailable:o=!1,isDownloaded:t,downloadPercent:r,version:a,onClickReady:s}){const i=o||t;return!d&&!i?null:i?e.jsxs("div",{className:"mx-2 mb-2",children:[e.jsx("style",{children:`
          @keyframes update-now-bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(1.5px); }
          }
          @keyframes update-now-pulse {
            0%, 100% {
              box-shadow:
                0 0 0 0 color-mix(in srgb, var(--primary) 0%, transparent),
                0 0 8px -2px color-mix(in srgb, var(--primary) 25%, transparent),
                inset 0 0 0 1px color-mix(in srgb, var(--primary) 18%, transparent);
            }
            50% {
              box-shadow:
                0 0 0 3px color-mix(in srgb, var(--primary) 0%, transparent),
                0 0 16px -2px color-mix(in srgb, var(--primary) 55%, transparent),
                inset 0 0 0 1px color-mix(in srgb, var(--primary) 38%, transparent);
            }
          }
          @keyframes update-now-shimmer {
            0% { transform: translateX(-140%) skewX(-22deg); opacity: 0; }
            10% { opacity: 1; }
            55%, 100% { transform: translateX(260%) skewX(-22deg); opacity: 0; }
          }
          @keyframes update-now-icon-glow {
            0%, 100% { filter: drop-shadow(0 0 0 color-mix(in srgb, var(--primary) 0%, transparent)); }
            50% { filter: drop-shadow(0 0 4px color-mix(in srgb, var(--primary) 70%, transparent)); }
          }
          @keyframes update-now-ripple {
            0% { transform: scale(0.6); opacity: 0.55; }
            100% { transform: scale(2.4); opacity: 0; }
          }
          .update-now-btn {
            animation: update-now-pulse 2.8s ease-in-out infinite;
          }
          .update-now-btn:hover {
            border-color: color-mix(in srgb, var(--primary) 75%, transparent);
            background-color: color-mix(in srgb, var(--primary) 8%, var(--panel));
          }
          .update-now-btn:active {
            transform: scale(0.96);
            transition-duration: 80ms;
          }
          .update-now-btn:active .ripple {
            animation: update-now-ripple 520ms ease-out forwards;
          }
          .update-now-btn:active .shimmer {
            animation-duration: 600ms;
          }
          .update-now-btn .shimmer {
            animation: update-now-shimmer 3.6s ease-in-out infinite;
          }
          .update-now-btn .icon {
            animation:
              update-now-bounce 1.8s ease-in-out infinite,
              update-now-icon-glow 2.8s ease-in-out infinite;
          }
        `}),e.jsxs("button",{onClick:s,disabled:!s,className:l("update-now-btn group","flex w-full items-center justify-center gap-1.5 h-8 px-3 rounded-full","text-[12px] font-semibold text-text-primary tracking-tight","bg-panel border border-border-hover cursor-pointer","transition-[transform,colors,border-color,background-color] duration-200 ease-out relative overflow-hidden","disabled:cursor-default disabled:opacity-95","focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"),title:s?a?t?`Update v${a} ready to install`:`Update v${a} available`:t?"Update ready to install":"Update available":"Update button preview",children:[e.jsx("span",{"aria-hidden":"true",className:"shimmer pointer-events-none absolute inset-y-0 -left-6 w-10 bg-gradient-to-r from-transparent via-primary/30 to-transparent"}),e.jsx("span",{"aria-hidden":"true",className:"ripple pointer-events-none absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/30 opacity-0"}),e.jsx("img",{src:f,alt:"","aria-hidden":"true",draggable:!1,className:"icon relative z-10 h-3.5 w-3.5 object-contain select-none"}),e.jsx("span",{className:"relative z-10",children:"Update Now"})]})]}):e.jsxs("div",{className:l("mx-2 mb-2 flex items-center justify-center gap-1.5 h-7 px-2 rounded-full","bg-surface/90 border border-border text-text-muted text-[11px]","pointer-events-none"),title:`Downloading update${r>0?` (${r}%)`:""}...`,children:[e.jsx(m,{size:12,className:"animate-spin text-info"}),r>0&&e.jsxs("span",{className:"tabular-nums",children:[r,"%"]})]})}export{S as UpdateNotificationModal,X as UpdateStatusIndicator,F as useUpdateNotification};
