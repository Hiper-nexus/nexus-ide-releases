// Nexus Redline (Windows) â€” companheiro de bandeja do NexusIDE.
// LÃª %USERPROFILE%\.nexus\redline-last-good.json (escrito pelo quota-service
// do Nexus) e mostra na bandeja a folga de cada conta de IA: painel escuro
// com barras 5h/semana, cores de urgÃªncia e cronÃ´metro atÃ© o reset.
//
// Doutrina (igual ao app de menu bar do Mac): read-only sobre os dados â€”
// nunca lÃª credencial, nunca renova token, nunca fala com provider ou rede.
// Ãšnico efeito colateral: o arquivo-sinal de refresh ("Atualizar agora") e
// a prÃ³pria instalaÃ§Ã£o/autostart, ambos por gesto explÃ­cito do usuÃ¡rio.
//
// Win32 puro + GDI/GDI+ (componentes do SO, sem terceiros). Sem console,
// sem CRT fora do bÃ¡sico, uma instÃ¢ncia (mutex nomeado).

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <windowsx.h>
#include <shellapi.h>
#include <shlobj.h>
#include <dwmapi.h>
#include <gdiplus.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "redline-model.h"

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "advapi32.lib")

namespace {

// â”€â”€ Paleta (tokens fixos â€” painel escuro sempre, igual ao Mac) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

constexpr COLORREF kBgHeader = RGB(0x14, 0x12, 0x18);
constexpr COLORREF kBgList = RGB(0x0C, 0x0A, 0x10);
constexpr COLORREF kGlassLine = RGB(0x32, 0x2E, 0x38);
constexpr COLORREF kGlassFill = RGB(0x1C, 0x19, 0x22);
constexpr COLORREF kText = RGB(0xFA, 0xF7, 0xF9);
constexpr COLORREF kTextDim = RGB(0xAA, 0xA2, 0xA8);
constexpr COLORREF kTextFaint = RGB(0x92, 0x8B, 0x90);
constexpr COLORREF kAccent = RGB(0xFF, 0x4F, 0x8B);
constexpr COLORREF kWarn = RGB(0xE5, 0xC0, 0x7B);
constexpr COLORREF kOk = RGB(0x7E, 0xE2, 0xA8);
constexpr COLORREF kDanger = RGB(0xFF, 0x6B, 0x4A);
constexpr COLORREF kHairline = RGB(0x22, 0x20, 0x24);
constexpr COLORREF kPrimaryFill = RGB(0xFA, 0xF7, 0xF9);
constexpr COLORREF kPrimaryInk = RGB(0x08, 0x07, 0x09);
constexpr COLORREF kGaugeTrack = RGB(0x2B, 0x28, 0x30);
// Ãcone da bandeja (fundo claro ou escuro â€” tintas vivas, nÃ£o as de painel).
COLORREF trayInk(redline::Urgency u) {
  switch (u) {
    case redline::Urgency::Ok: return RGB(0x2E, 0xB7, 0x5E);
    case redline::Urgency::Warn: return RGB(0xE5, 0xC0, 0x7B);
    case redline::Urgency::Danger: return RGB(0xFF, 0x6B, 0x4A);
    case redline::Urgency::Unknown: return RGB(0x88, 0x8A, 0x8F);
  }
  return RGB(0x88, 0x8A, 0x8F);
}
COLORREF urgencyInkPanel(bool has, double used) {
  if (!has) return kTextFaint;
  if (used >= 0.85) return kDanger;
  if (used >= 0.60) return kWarn;
  return kOk;
}

// â”€â”€ Utilidades â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

std::wstring toWide(const std::string& utf8) {
  if (utf8.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
  if (n <= 0) return L"";
  std::wstring out(static_cast<size_t>(n) - 1, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, out.data(), n);
  return out;
}

std::int64_t nowMs() {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER u;
  u.LowPart = ft.dwLowDateTime;
  u.HighPart = ft.dwHighDateTime;
  // 100ns desde 1601 â†’ ms desde 1970 (11644473600s de diferenÃ§a).
  return static_cast<std::int64_t>(u.QuadPart / 10000ULL) -
         static_cast<std::int64_t>(11644473600LL * 1000);
}

std::wstring exeDir() {
  wchar_t buf[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
  std::wstring full(buf, n);
  size_t slash = full.find_last_of(L"\\/");
  return slash == std::wstring::npos ? L"." : full.substr(0, slash);
}

// â”€â”€ Autostart (HKCU\...\Run â€” por usuÃ¡rio, sem admin) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

constexpr wchar_t kRunKey[] =
    L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kRunValue[] = L"NexusRedline";

std::wstring quotedExePath() {
  wchar_t buf[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
  return L"\"" + std::wstring(buf, n) + L"\"";
}

bool autostartEnabled() {
  wchar_t data[512];
  DWORD size = sizeof(data);
  DWORD type = 0;
  LONG rc = RegGetValueW(HKEY_CURRENT_USER, kRunKey, kRunValue,
                         RRF_RT_REG_SZ, &type, data, &size);
  if (rc != ERROR_SUCCESS) return false;
  return _wcsicmp(data, quotedExePath().c_str()) == 0;
}

bool setAutostart(bool on) {
  if (!on) {
    LONG rc = RegDeleteKeyValueW(HKEY_CURRENT_USER, kRunKey, kRunValue);
    return rc == ERROR_SUCCESS || rc == ERROR_FILE_NOT_FOUND;
  }
  std::wstring v = quotedExePath();
  LONG rc = RegSetKeyValueW(
      HKEY_CURRENT_USER, kRunKey, kRunValue, REG_SZ, v.c_str(),
      static_cast<DWORD>((v.size() + 1) * sizeof(wchar_t)));
  return rc == ERROR_SUCCESS;
}

// â”€â”€ Logos dos providers (PNGs ao lado do exe + manifest.json) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

struct LogoManifestEntry {
  std::string file;
  bool mono = false;
};

bool loadLogoManifest(const std::wstring& dir,
                      std::vector<std::pair<std::string, LogoManifestEntry>>& out) {
  std::wstring wpath = dir + L"\\provider-logos\\manifest.json";
  // Reusa o parser do modelo: lÃª bytes e decodifica como UTF-8.
  HANDLE h = CreateFileW(wpath.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                         OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  DWORD size = GetFileSize(h, nullptr);
  std::string bytes;
  if (size != INVALID_FILE_SIZE && size < 1 * 1024 * 1024) {
    bytes.resize(size);
    DWORD read = 0;
    if (!ReadFile(h, bytes.data(), size, &read, nullptr)) bytes.clear();
    bytes.resize(read);
  }
  CloseHandle(h);
  if (bytes.empty()) return false;
  auto v = redline::parseJson(bytes);
  if (!v || v->type != redline::JsonValue::Type::Object || !v->object)
    return false;
  for (const auto& kv : *v->object) {
    if (kv.second.type != redline::JsonValue::Type::Object) continue;
    LogoManifestEntry e;
    e.file = kv.second.asString();
    const redline::JsonValue* f = kv.second.find("file");
    if (f && f->type == redline::JsonValue::Type::String) e.file = f->str;
    const redline::JsonValue* m = kv.second.find("mono");
    e.mono = m && m->type == redline::JsonValue::Type::Bool && m->boolean;
    if (!e.file.empty()) out.emplace_back(kv.first, e);
  }
  return true;
}

const LogoManifestEntry* findLogo(
    const std::vector<std::pair<std::string, LogoManifestEntry>>& manifest,
    const std::string& adapter) {
  for (const auto& kv : manifest) {
    if (kv.first == adapter) return &kv.second;
  }
  return nullptr;
}

// Matriz que inverte RGB preservando alfa: marca mono preta vira clara
// sobre o painel near-black (o Mac tinge de template; aqui Ã© o equivalente).
void monoAttributes(Gdiplus::ImageAttributes& attr) {
  Gdiplus::ColorMatrix m = {-1, 0, 0, 0, 0,  //
                            0, -1, 0, 0, 0,  //
                            0, 0, -1, 0, 0,  //
                            0, 0, 0, 1, 0,  //
                            1, 1, 1, 0, 1};
  attr.SetColorMatrix(&m);
}

// â”€â”€ Estado global â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

constexpr UINT kTrayCallbackMsg = WM_APP + 1;
constexpr UINT kReloadMsg = WM_APP + 2;
constexpr UINT kTrayIconId = 1;
constexpr UINT_PTR kPollTimer = 1;
constexpr UINT kPollMs = 2000;

struct AppState {
  HINSTANCE inst = nullptr;
  HWND trayWnd = nullptr;    // janela oculta dona do Ã­cone
  HWND panelWnd = nullptr;   // popup do painel (null quando fechado)
  HICON trayIcon = nullptr;
  std::optional<redline::RedlineSnapshot> snap;
  bool hasSnap = false;
  std::wstring homeW;      // ~/.nexus (wide p/ watch)
  std::string homeUtf8;    // idem UTF-8 p/ leitura/refresh
  std::wstring snapPathW;  // arquivo de snapshot
  FILETIME snapWrite = {};  // mtime observada (poll de seguranÃ§a)
  DWORD snapSize = 0;
  HANDLE dirChange = nullptr;  // FindFirstChangeNotification(~/.nexus)
  HANDLE watchThread = nullptr;
  DWORD watchThreadId = 0;
  std::vector<std::pair<std::string, LogoManifestEntry>> logos;
  std::wstring logoDir;
  bool launchAtLogin = false;
  ULONG_PTR gdiplusToken = 0;
};

AppState g;

// â”€â”€ Fontes e DPI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

struct Fonts {
  HFONT fTitle = nullptr;   // 13 semibold
  HFONT fBody = nullptr;    // 12 regular
  HFONT fBodySB = nullptr;  // 12 semibold
  HFONT fSmall = nullptr;   // 11 regular
  HFONT fSmallSB = nullptr;  // 11 semibold
};

Fonts gFonts;
int gDpi = 96;

int S(int px) { return MulDiv(px, gDpi, 96); }  // escala p/ o DPI do monitor

HFONT makeFont(int px, int weight) {
  // Pixels do painel (S), não pontos. /72 deixava o tipo ~33% maior que as
  // faixas de 20px e o rodapé empilhava em cima da última conta.
  return CreateFontW(-S(px), 0, 0, 0, weight, FALSE, FALSE, FALSE,
                     DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                     CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE,
                     L"Segoe UI");
}

int fontBox(HDC hdc, HFONT font) {
  HGDIOBJ old = SelectObject(hdc, font);
  TEXTMETRICW tm{};
  GetTextMetricsW(hdc, &tm);
  SelectObject(hdc, old);
  return tm.tmHeight + tm.tmExternalLeading;
}

void initFonts() {
  gFonts.fTitle = makeFont(13, FW_SEMIBOLD);
  gFonts.fBody = makeFont(12, FW_NORMAL);
  gFonts.fBodySB = makeFont(12, FW_SEMIBOLD);
  gFonts.fSmall = makeFont(11, FW_NORMAL);
  gFonts.fSmallSB = makeFont(11, FW_SEMIBOLD);
}

void destroyFonts() {
  for (HFONT f : {gFonts.fTitle, gFonts.fBody, gFonts.fBodySB, gFonts.fSmall,
                  gFonts.fSmallSB}) {
    if (f) DeleteObject(f);
  }
  gFonts = Fonts();
}

// â”€â”€ Snapshot: recarrega quando o arquivo mudou â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

bool snapshotChangedOnDisk() {
  WIN32_FILE_ATTRIBUTE_DATA attr;
  if (!GetFileAttributesExW(g.snapPathW.c_str(), GetFileExInfoStandard,
                            &attr)) {
    // Sumiu: sÃ³ Ã© "mudanÃ§a" se antes havia dados.
    return g.hasSnap;
  }
  if (attr.nFileSizeLow != g.snapSize ||
      CompareFileTime(&attr.ftLastWriteTime, &g.snapWrite) != 0) {
    g.snapWrite = attr.ftLastWriteTime;
    g.snapSize = attr.nFileSizeLow;
    return true;
  }
  return false;
}

void reloadSnapshot() {
  auto snap = redline::loadSnapshotFile(
      redline::snapshotPathForHome(g.homeUtf8));
  g.hasSnap = snap.has_value();
  g.snap = std::move(snap);
}

// â”€â”€ Ãcone da bandeja â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

bool insideRoundRect(int x, int y, int n, int rad) {
  const int left = 1;
  const int top = 1;
  const int right = n - 2;
  const int bottom = n - 2;
  if (x < left || y < top || x > right || y > bottom) return false;
  const int rr = rad * rad;
  if (x < left + rad && y < top + rad) {
    int dx = x - (left + rad);
    int dy = y - (top + rad);
    return dx * dx + dy * dy <= rr;
  }
  if (x > right - rad && y < top + rad) {
    int dx = x - (right - rad);
    int dy = y - (top + rad);
    return dx * dx + dy * dy <= rr;
  }
  if (x < left + rad && y > bottom - rad) {
    int dx = x - (left + rad);
    int dy = y - (bottom - rad);
    return dx * dx + dy * dy <= rr;
  }
  if (x > right - rad && y > bottom - rad) {
    int dx = x - (right - rad);
    int dy = y - (bottom - rad);
    return dx * dx + dy * dy <= rr;
  }
  return true;
}

// Placa clara + losango rosa/ciano. O ícone antigo era a marca em cima de
// preto: no overflow escuro do Windows virava um quadrado preto e sumia.
HICON makeTrayIcon(redline::Urgency urgency, bool stale) {
  const int N = 32;
  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = N;
  bi.bmiHeader.biHeight = N;  // bottom-up: CreateIconIndirect ignora DIB top-down
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HDC screen = GetDC(nullptr);
  HBITMAP color = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  ReleaseDC(nullptr, screen);
  if (!color || !bits) {
    if (color) DeleteObject(color);
    return static_cast<HICON>(LoadImageW(nullptr, IDI_APPLICATION, IMAGE_ICON,
                                         N, N, LR_SHARED));
  }
  auto* px = static_cast<std::uint32_t*>(bits);
  std::memset(px, 0, static_cast<size_t>(N) * N * 4);
  auto put = [&](int x, int y, int red, int green, int blue, int a) {
    if (static_cast<unsigned>(x) >= static_cast<unsigned>(N) ||
        static_cast<unsigned>(y) >= static_cast<unsigned>(N) || a <= 0) {
      return;
    }
    int row = (N - 1) - y;
    auto* p = reinterpret_cast<std::uint8_t*>(&px[row * N + x]);
    p[0] = static_cast<std::uint8_t>(blue * a / 255);
    p[1] = static_cast<std::uint8_t>(green * a / 255);
    p[2] = static_cast<std::uint8_t>(red * a / 255);
    p[3] = static_cast<std::uint8_t>(a);
  };
  for (int y = 0; y < N; ++y) {
    for (int x = 0; x < N; ++x) {
      if (!insideRoundRect(x, y, N, 8)) continue;
      put(x, y, 0xF6, 0xF3, 0xF8, 255);
    }
  }
  const int cx = N / 2;
  const int cy = N / 2 - 1;
  for (int y = 0; y < N; ++y) {
    for (int x = 0; x < N; ++x) {
      int dx = x > cx ? x - cx : cx - x;
      int dy = y > cy ? y - cy : cy - y;
      int man = dx + dy;
      if (man > 8 || man < 3) continue;
      if (x < cx) put(x, y, 0xFF, 0x4F, 0x8B, 255);
      else put(x, y, 0x3C, 0xD0, 0xFF, 255);
    }
  }
  COLORREF ink = trayInk(urgency);
  const int ox = N - 8;
  const int oy = N - 8;
  const int rad = 5;
  for (int y = oy - rad; y <= oy + rad; ++y) {
    for (int x = ox - rad; x <= ox + rad; ++x) {
      int dx = x - ox;
      int dy = y - oy;
      int d2 = dx * dx + dy * dy;
      if (d2 > rad * rad) continue;
      if (stale && d2 <= (rad - 2) * (rad - 2)) continue;
      put(x, y, GetRValue(ink), GetGValue(ink), GetBValue(ink), 255);
    }
  }
  // Máscara zerada: o canal alpha do DIB de 32 bpp é que recorta.
  HBITMAP mask = CreateBitmap(N, N, 1, 1, nullptr);
  ICONINFO info{};
  info.fIcon = TRUE;
  info.hbmColor = color;
  info.hbmMask = mask;
  HICON icon = CreateIconIndirect(&info);
  DeleteObject(color);
  DeleteObject(mask);
  return icon;
}

// O Windows esconde ícone novo no ^ e, sem IsPromoted, ele nem fica óbvio
// ali. Marca o exe que está rodando para a bandeja visível.
bool promoteTrayIcon() {
  wchar_t exe[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, exe, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return false;
  HKEY root = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Control Panel\\NotifyIconSettings",
                    0, KEY_READ, &root) != ERROR_SUCCESS) {
    return false;
  }
  bool promoted = false;
  DWORD index = 0;
  wchar_t name[80];
  while (!promoted) {
    DWORD nameLen = 80;
    LONG st = RegEnumKeyExW(root, index++, name, &nameLen, nullptr, nullptr,
                            nullptr, nullptr);
    if (st != ERROR_SUCCESS) break;
    HKEY sub = nullptr;
    if (RegOpenKeyExW(root, name, 0, KEY_QUERY_VALUE | KEY_SET_VALUE, &sub) !=
        ERROR_SUCCESS) {
      continue;
    }
    wchar_t path[MAX_PATH];
    DWORD cb = sizeof(path);
    DWORD type = 0;
    if (RegQueryValueExW(sub, L"ExecutablePath", nullptr, &type,
                         reinterpret_cast<BYTE*>(path), &cb) == ERROR_SUCCESS &&
        type == REG_SZ && _wcsicmp(path, exe) == 0) {
      DWORD one = 1;
      promoted = RegSetValueExW(sub, L"IsPromoted", 0, REG_DWORD,
                               reinterpret_cast<const BYTE*>(&one),
                               sizeof(one)) == ERROR_SUCCESS;
    }
    RegCloseKey(sub);
  }
  RegCloseKey(root);
  return promoted;
}

// Tooltip sÃ³-texto (fonte da bandeja nem sempre tem os glifos â–®/âœ³).
std::wstring trayTooltip() {
  std::int64_t now = nowMs();
  if (!g.hasSnap || !g.snap || g.snap->entries.empty())
    return L"Nexus Redline \u00B7 sem dados do Nexus. Abra o Nexus para carregar.";
  const auto& snap = *g.snap;
  size_t count = snap.entries.size();
  std::wstring head = L"Nexus Redline \u00B7 " + std::to_wstring(count) +
                      (count == 1 ? L" conta \u00B7 " : L" contas \u00B7 ");
  redline::WorstWindow w = redline::worstBarWindow(snap);
  std::wstring mid;
  if (w.entry && w.window) {
    std::string pct = redline::pctText(true, w.window->usedRatio);
    mid = toWide(pct) + L" em " + toWide(w.entry->label) + L" \u00B7 ";
  } else {
    mid = L"sem leitura \u00B7 ";
  }
  std::wstring tail = toWide(redline::ageLabel(snap.updatedAt, now));
  if (redline::isStale(snap, now)) tail += L" \u00B7 Nexus offline";
  std::wstring tip = head + mid + tail + L". Clique para ver todas as cotas.";
  if (tip.size() > 120) {
    // NSS tooltip: 128 wchar_t; corta em 117 + "…" sem partir surrogate
    // (rótulo de conta pode conter emoji).
    static_assert(sizeof(wchar_t) == 2, "clipUtf16 exige UTF-16");
    std::u16string clipped = redline::clipUtf16(
        std::u16string(reinterpret_cast<const char16_t*>(tip.data()),
                       tip.size()),
        117);
    tip.assign(reinterpret_cast<const wchar_t*>(clipped.data()),
               clipped.size());
    tip += L"...";
  }
  return tip;
}

void refreshTray() {
  redline::Urgency urgency = redline::Urgency::Unknown;
  bool stale = true;
  if (g.hasSnap && g.snap && !g.snap->entries.empty()) {
    std::int64_t now = nowMs();
    stale = redline::isStale(*g.snap, now);
    redline::WorstWindow w = redline::worstBarWindow(*g.snap);
    if (w.window)
      urgency = redline::urgencyFor(true, w.window->usedRatio);
  }
  HICON icon = makeTrayIcon(urgency, stale);
  if (g.trayIcon) DestroyIcon(g.trayIcon);
  g.trayIcon = icon;
  NOTIFYICONDATAW nid = {};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g.trayWnd;
  nid.uID = kTrayIconId;
  nid.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE;
  nid.uCallbackMessage = kTrayCallbackMsg;
  nid.hIcon = icon;
  std::wstring tip = trayTooltip();
  wcsncpy_s(nid.szTip, tip.c_str(), _TRUNCATE);
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}

// Balão de primeira execução: o Windows esconde ícones novos no overflow
// (^) — sem isso o operador instala e "não aparece nada" (o Mac não tem
// esse problema: item de menu bar é sempre visível). Só no lançamento
// pós-instalação (--first-run); boot por autostart nunca insiste.
void showFirstRunBalloon() {
  NOTIFYICONDATAW nid = {};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g.trayWnd;
  nid.uID = kTrayIconId;
  nid.uFlags = NIF_INFO;
  wcsncpy_s(nid.szInfoTitle, L"Nexus Redline", _TRUNCATE);
  wcsncpy_s(nid.szInfo,
            L"Cotas das suas contas de IA na bandeja. "
            L"Clique no ^ e arraste o ícone para fixá-lo aqui.",
            _TRUNCATE);
  nid.dwInfoFlags = NIIF_INFO | NIIF_LARGE_ICON;
  nid.uTimeout = 10000;
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}

void addTrayIcon() {
  NOTIFYICONDATAW nid = {};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g.trayWnd;
  nid.uID = kTrayIconId;
  nid.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE;
  nid.uCallbackMessage = kTrayCallbackMsg;
  nid.hIcon = makeTrayIcon(redline::Urgency::Unknown, true);
  g.trayIcon = nid.hIcon;
  wcsncpy_s(nid.szTip, L"Nexus Redline", _TRUNCATE);
  // Ícone zumbi do exe anterior ocupa o mesmo uID e o ADD novo falha em silêncio.
  Shell_NotifyIconW(NIM_DELETE, &nid);
  Shell_NotifyIconW(NIM_ADD, &nid);
  // VersÃ£o 4: clique esquerdo selecionÃ¡vel + balÃµes modernos.
  nid.uVersion = NOTIFYICON_VERSION_4;
  Shell_NotifyIconW(NIM_SETVERSION, &nid);
  promoteTrayIcon();
}

// â”€â”€ Painel: controles e geometria â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

enum class Ctl { None, Refresh, Open, Login, Quit };

Ctl gHover = Ctl::None;
Ctl gFocus = Ctl::Refresh;
// Seam de teste (--toggle-panel): true quando o painel chegou a abrir.
bool gPanelEverOpened = false;
// --toggle-panel abre e sai sozinho (~3s); --open-panel abre e fica.
bool gTogglePanelProbe = false;
bool gTrayPromoted = false;
int gScrollY = 0;
int gContentH = 0;
RECT gRefreshRc = {};
RECT gOpenRc = {};
RECT gLoginRc = {};
RECT gQuitRc = {};
RECT gListRc = {};

constexpr int kPanelW = 400;

int panelHeightFor(HWND hwnd) {
  RECT work = {};
  if (HMONITOR mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)) {
    MONITORINFO mi = {};
    mi.cbSize = sizeof(mi);
    if (GetMonitorInfoW(mon, &mi)) work = mi.rcWork;
  }
  if (work.bottom <= work.top) {
    work.top = 0;
    work.bottom = 700;
  }
  int avail = (work.bottom - work.top) - 32;
  if (avail < 240) avail = 240;
  if (avail > 600) avail = 600;
  return avail;
}

// Texto em uma linha com elipse; retorna a largura desenhada.
int drawSingleLine(HDC hdc, const std::wstring& text, HFONT font,
                   COLORREF color, int x, int y, int w) {
  HGDIOBJ old = SelectObject(hdc, font);
  SetTextColor(hdc, color);
  SetBkMode(hdc, TRANSPARENT);
  RECT rc = {x, y, x + w, y + 400};
  DrawTextW(hdc, text.c_str(), static_cast<int>(text.size()), &rc,
            DT_SINGLELINE | DT_LEFT | DT_TOP | DT_END_ELLIPSIS | DT_NOPREFIX);
  SIZE sz{};
  GetTextExtentPoint32W(hdc, text.c_str(), static_cast<int>(text.size()), &sz);
  SelectObject(hdc, old);
  int drawn = sz.cx;
  if (drawn > w) drawn = w;
  return drawn < 0 ? 0 : drawn;
}

// Bloco com quebra de linha; retorna a altura consumida (0 mede tambÃ©m).
int drawWrapped(HDC hdc, const std::wstring& text, HFONT font, COLORREF color,
                int x, int y, int w, bool measure) {
  HGDIOBJ old = SelectObject(hdc, font);
  SetTextColor(hdc, color);
  SetBkMode(hdc, TRANSPARENT);
  RECT rc = {x, y, x + w, y + 10000};
  UINT flags = DT_LEFT | DT_TOP | DT_WORDBREAK | DT_NOPREFIX;
  if (measure) flags |= DT_CALCRECT;
  int h = DrawTextW(hdc, text.c_str(), static_cast<int>(text.size()), &rc,
                    flags);
  SelectObject(hdc, old);
  return h;
}

int textWidth(HDC hdc, const std::wstring& text, HFONT font) {
  HGDIOBJ old = SelectObject(hdc, font);
  SIZE sz = {};
  GetTextExtentPoint32W(hdc, text.c_str(), static_cast<int>(text.size()),
                        &sz);
  SelectObject(hdc, old);
  return sz.cx;
}

// Logos: cache por adapter (Bitmap GDI+ carregado do disco uma vez).
struct LogoCache {
  std::map<std::string, std::unique_ptr<Gdiplus::Bitmap>> imgs;
  std::map<std::string, bool> mono;
};
LogoCache gLogoCache;

// Não-const de propósito: GetWidth/GetHeight do GDI+ não são const.
Gdiplus::Bitmap* logoFor(const std::string& adapter) {
  auto it = gLogoCache.imgs.find(adapter);
  if (it != gLogoCache.imgs.end()) return it->second.get();
  const LogoManifestEntry* info = findLogo(g.logos, adapter);
  if (!info) {
    gLogoCache.imgs[adapter] = nullptr;
    return nullptr;
  }
  std::wstring path = g.logoDir + L"\\provider-logos\\" + toWide(info->file);
  auto bmp = std::make_unique<Gdiplus::Bitmap>(path.c_str());
  if (bmp->GetLastStatus() != Gdiplus::Ok) {
    gLogoCache.imgs[adapter] = nullptr;
    return nullptr;
  }
  gLogoCache.mono[adapter] = info->mono;
  return (gLogoCache.imgs[adapter] = std::move(bmp)).get();
}

// Desenha uma conta; retorna a altura da row (pads de 12 incluÃ­dos).
int drawEntry(HDC hdc, Gdiplus::Graphics* gfx,
              const redline::RedlineEntry& e, int x, int y, int w,
              bool measure, std::int64_t now) {
  const int pad = S(12);
  const int gap = S(4);
  const int inset = S(16);
  int cx = x + inset;
  int cw = w - inset * 2;
  int cur = y + pad;

  // Linha 1: logo + tÃ­tulo + chip "Ativa".
  // A presenÃ§a do logo decide a largura do tÃ­tulo â€” vale igual no measure
  // e no paint, senÃ£o o texto medido clipa na pintura.
  const bool hasLogo = findLogo(g.logos, e.adapterId) != nullptr;
  Gdiplus::Bitmap* logo = (!measure && hasLogo) ? logoFor(e.adapterId)
                                                 : nullptr;
  int chipW = 0;
  if (e.active) {
    chipW = S(6 + 5) +
            textWidth(hdc, L"Ativa", gFonts.fSmall);  // dot 6 + gap 5
  }
  int titleX = cx + (hasLogo ? S(16 + 8) : 0);
  int titleW = cw - (hasLogo ? S(16 + 8) : 0) - (chipW ? chipW + S(8) : 0);
  if (titleW < S(24)) titleW = S(24);
  std::string titleSrc = e.label;
  {
    // TÃ­tulo redundante com o provider some (igual ao Mac).
    std::string prov = redline::providerName(e.adapterId);
    if (_stricmp(titleSrc.c_str(), prov.c_str()) == 0) titleSrc = prov;
  }
  int titleH = drawWrapped(hdc, toWide(titleSrc), gFonts.fBodySB, kText, titleX,
                           cur, titleW, measure);
  int headH = titleH;
  if (S(17) > headH) headH = S(17);
  if (!measure) {
    if (logo) {
      Gdiplus::ImageAttributes attr;
      if (gLogoCache.mono[e.adapterId]) monoAttributes(attr);
      gfx->DrawImage(logo, Gdiplus::Rect(cx, cur + S(1), S(16), S(16)), 0, 0,
                     static_cast<INT>(logo->GetWidth()),
                     static_cast<INT>(logo->GetHeight()), Gdiplus::UnitPixel,
                     &attr);
    }
    if (e.active) {
      int dotX = titleX + titleW + S(8);
      int dotY = cur + (headH - S(6)) / 2;
      HBRUSH dot = CreateSolidBrush(kAccent);
      HBRUSH oldB = static_cast<HBRUSH>(SelectObject(hdc, dot));
      HPEN none = static_cast<HPEN>(GetStockObject(NULL_PEN));
      HPEN oldP = static_cast<HPEN>(SelectObject(hdc, none));
      Ellipse(hdc, dotX, dotY, dotX + S(6), dotY + S(6));
      SelectObject(hdc, oldP);
      SelectObject(hdc, oldB);
      DeleteObject(dot);
      drawSingleLine(hdc, L"Ativa", gFonts.fSmall, kAccent, dotX + S(6 + 5),
                     cur + (headH - S(13)) / 2, chipW);
    }
  }
  cur += headH + gap;

  // E-mail mascarado (sÃ³ quando nÃ£o Ã© substring do rÃ³tulo).
  if (!e.emailMasked.empty() &&
      e.label.find(e.emailMasked) == std::string::npos) {
    cur += drawWrapped(hdc, toWide(e.emailMasked), gFonts.fSmall, kTextFaint,
                       cx, cur, cw, measure) +
           gap;
  }

  // Estado (avisos em palavras, nunca sÃ³ cor).
  std::string state = redline::accountState(e, now);
  if (!state.empty()) {
    cur += drawWrapped(hdc, toWide(state), gFonts.fSmall, kWarn, cx, cur, cw,
                       measure) +
           gap;
  }

  // Janelas de cota.
  if (e.windows.empty()) {
    cur += drawWrapped(hdc, L"Sem leitura de cota", gFonts.fSmall, kTextFaint,
                       cx, cur, cw, measure) +
           gap;
  }
  for (const redline::RedlineWindow& win : e.windows) {
    if (!win.hasUsed) {
      cur += drawWrapped(hdc, toWide(win.label) + L" \u00B7 Sem leitura",
                         gFonts.fSmall, kTextFaint, cx, cur, cw, measure) +
             gap;
      continue;
    }
    // Linha: medidor 56Ã—4 + texto segmentado em uma linha com elipse.
    const int gaugeW = S(56);
    const int lineGap = S(10);
    std::wstring wlabel = toWide(win.label);
    std::wstring wpct = toWide(redline::pctText(true, win.usedRatio));
    std::wstring wused = L" usado";
    std::wstring wreset = win.hasResetsAt
                              ? L" \u00B7 reseta em " +
                                    toWide(redline::countdownText(
                                        true, win.resetsAt, now))
                              : L"";
    int fixedW = textWidth(hdc, wpct, gFonts.fSmallSB) +
                 textWidth(hdc, wused, gFonts.fSmall) +
                 textWidth(hdc, wreset, gFonts.fSmall) +
                 textWidth(hdc, L" \u00B7 ", gFonts.fSmall);
    int labelAvail = cw - gaugeW - lineGap - fixedW;
    if (labelAvail < S(20)) labelAvail = S(20);
    int lineH = S(15);
    if (S(15) < S(4) + S(8)) lineH = S(4) + S(8);
    if (!measure) {
      int gy = cur + (lineH - S(4)) / 2;
      HBRUSH track = CreateSolidBrush(kGaugeTrack);
      HBRUSH oldB = static_cast<HBRUSH>(SelectObject(hdc, track));
      HPEN none = static_cast<HPEN>(GetStockObject(NULL_PEN));
      HPEN oldP = static_cast<HPEN>(SelectObject(hdc, none));
      RoundRect(hdc, cx, gy, cx + gaugeW, gy + S(4), S(4), S(4));
      double clamped = win.usedRatio < 0
                           ? 0
                           : (win.usedRatio > 1 ? 1 : win.usedRatio);
      int fillW = static_cast<int>(gaugeW * clamped);
      if (clamped > 0 && fillW < S(2)) fillW = S(2);
      if (fillW > 0) {
        HBRUSH fill = CreateSolidBrush(
            urgencyInkPanel(true, win.usedRatio));
        SelectObject(hdc, fill);
        RoundRect(hdc, cx, gy, cx + fillW, gy + S(4), S(4), S(4));
        SelectObject(hdc, oldB);
        DeleteObject(fill);
      }
      SelectObject(hdc, oldP);
      SelectObject(hdc, oldB);
      DeleteObject(track);
      int tx = cx + gaugeW + lineGap;
      int ty = cur;
      tx += drawSingleLine(hdc, wlabel + L" \u00B7 ", gFonts.fSmall, kTextDim,
                           tx, ty, labelAvail + textWidth(hdc, L" \u00B7 ", gFonts.fSmall));
      tx += drawSingleLine(hdc, wpct, gFonts.fSmallSB,
                           urgencyInkPanel(true, win.usedRatio), tx, ty,
                           cw - (tx - cx));
      tx += drawSingleLine(hdc, wused, gFonts.fSmall, kTextDim, tx, ty,
                           cw - (tx - cx));
      drawSingleLine(hdc, wreset, gFonts.fSmall, kTextFaint, tx, ty,
                     cw - (tx - cx));
    }
    cur += lineH + gap;
  }
  return (cur - gap) + pad - y;
}

// â”€â”€ Header e footer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

void paintButton(HDC hdc, const RECT& rc, const std::wstring& text, bool primary,
                 bool hover, bool focused) {
  HBRUSH fill = nullptr;
  HPEN border = static_cast<HPEN>(GetStockObject(NULL_PEN));
  COLORREF ink = primary ? kPrimaryInk : kText;
  HFONT font = gFonts.fBody;
  if (primary) {
    COLORREF c = kPrimaryFill;
    if (hover) c = RGB(0xD8, 0xD4, 0xD8);
    fill = CreateSolidBrush(c);
  } else if (hover) {
    fill = CreateSolidBrush(RGB(0x2A, 0x26, 0x30));
    border = CreatePen(PS_SOLID, 1, RGB(0x4A, 0x45, 0x52));
  } else {
    fill = CreateSolidBrush(kGlassFill);
    border = CreatePen(PS_SOLID, 1, kGlassLine);
  }
  HBRUSH oldB = static_cast<HBRUSH>(SelectObject(hdc, fill ? fill : static_cast<HBRUSH>(GetStockObject(HOLLOW_BRUSH))));
  HPEN oldP = static_cast<HPEN>(SelectObject(hdc, border));
  RoundRect(hdc, rc.left, rc.top, rc.right, rc.bottom, S(16), S(16));
  SelectObject(hdc, oldB);
  SelectObject(hdc, oldP);
  if (fill) DeleteObject(fill);
  if (border != GetStockObject(NULL_PEN)) DeleteObject(border);
  HGDIOBJ oldF = SelectObject(hdc, font);
  SetTextColor(hdc, ink);
  SetBkMode(hdc, TRANSPARENT);
  DrawTextW(hdc, text.c_str(), static_cast<int>(text.size()),
            const_cast<RECT*>(&rc),
            DT_SINGLELINE | DT_CENTER | DT_VCENTER | DT_NOPREFIX);
  SelectObject(hdc, oldF);
  if (focused) {
    RECT fr = rc;
    InflateRect(&fr, -S(3), -S(3));
    DrawFocusRect(hdc, &fr);
  }
}

void paintGhost(HDC hdc, const RECT& rc, const std::wstring& text, bool hover,
                bool focused) {
  HGDIOBJ oldF = SelectObject(hdc, gFonts.fSmall);
  SetTextColor(hdc, hover ? kTextDim : kTextFaint);
  SetBkMode(hdc, TRANSPARENT);
  DrawTextW(hdc, text.c_str(), static_cast<int>(text.size()),
            const_cast<RECT*>(&rc),
            DT_SINGLELINE | DT_CENTER | DT_VCENTER | DT_NOPREFIX);
  SelectObject(hdc, oldF);
  if (focused) DrawFocusRect(hdc, const_cast<RECT*>(&rc));
}

void paintCheckbox(HDC hdc, const RECT& rc, bool on, bool hover,
                   bool focused) {
  int box = S(13);
  int boxY = rc.top + (rc.bottom - rc.top - box) / 2;
  HPEN pen = CreatePen(PS_SOLID, S(1), hover ? kTextDim : kTextFaint);
  HPEN oldP = static_cast<HPEN>(SelectObject(hdc, pen));
  HBRUSH oldB = static_cast<HBRUSH>(
      SelectObject(hdc, GetStockObject(HOLLOW_BRUSH)));
  Rectangle(hdc, rc.left, boxY, rc.left + box, boxY + box);
  SelectObject(hdc, oldB);
  SelectObject(hdc, oldP);
  DeleteObject(pen);
  if (on) {
    HGDIOBJ oldF = SelectObject(hdc, gFonts.fSmallSB);
    SetTextColor(hdc, kText);
    SetBkMode(hdc, TRANSPARENT);
    RECT cr = {rc.left, boxY - S(1), rc.left + box, boxY + box + S(1)};
    DrawTextW(hdc, L"\u2713", 1, &cr,
              DT_SINGLELINE | DT_CENTER | DT_VCENTER | DT_NOPREFIX);
    SelectObject(hdc, oldF);
  }
  RECT lr = {rc.left + box + S(8), rc.top, rc.right, rc.bottom};
  HGDIOBJ oldF = SelectObject(hdc, gFonts.fSmall);
  SetTextColor(hdc, kTextDim);
  SetBkMode(hdc, TRANSPARENT);
  DrawTextW(hdc, L"Iniciar com o Windows", -1, &lr,
            DT_SINGLELINE | DT_LEFT | DT_VCENTER | DT_NOPREFIX);
  SelectObject(hdc, oldF);
  if (focused) DrawFocusRect(hdc, const_cast<RECT*>(&rc));
}

// Altura total do conteÃºdo da lista (measure em DC de tela).
int measureContent(HDC hdc, int listW, std::int64_t now) {
  if (!g.hasSnap || !g.snap || g.snap->entries.empty()) {
    int h = S(12);
    h += drawWrapped(hdc, L"Sem dados ainda.", gFonts.fBody, kTextDim, 0, 0,
                     listW - S(32), true);
    h += S(4);
    h += drawWrapped(hdc, L"Abra o Nexus e atualize as cotas para ver o painel.",
                     gFonts.fSmall, kTextFaint, 0, 0, listW - S(32), true);
    return h + S(12);
  }
  int h = 0;
  for (const auto& e : g.snap->entries) {
    h += drawEntry(hdc, nullptr, e, 0, 0, listW, true, now);
  }
  return h;
}

struct ChromeBand {
  int topH = 0;
  int bottomH = 0;
  int row1Y = 0;
  int row1H = 0;
  int row2Y = 0;
  int row2H = 0;
  int titleY = 0;
  int summaryY = 0;
  int recoY = 0;
};

ChromeBand measureChrome(HDC hdc, int H) {
  // `small` é macro do Windows (rpcndr.h → char). Não usar esse nome.
  int smallH = fontBox(hdc, gFonts.fSmall);
  int titleH = fontBox(hdc, gFonts.fTitle);
  int pad = S(14);
  int gap = S(4);
  ChromeBand c;
  c.row1H = smallH + S(6);
  if (c.row1H < S(22)) c.row1H = S(22);
  c.row2H = S(32);
  c.row1Y = pad;
  c.row2Y = c.row1Y + c.row1H + S(8);
  c.topH = c.row2Y + c.row2H + pad;
  c.bottomH = pad + titleH + gap + smallH + gap + smallH + pad;
  int minList = S(80);
  if (c.topH + c.bottomH + minList > H && H > minList) {
    int overflow = c.topH + c.bottomH + minList - H;
    if (c.bottomH > overflow + pad) c.bottomH -= overflow;
  }
  int y = (H - c.bottomH) + pad;
  c.titleY = y;
  y += titleH + gap;
  c.summaryY = y;
  y += smallH + gap;
  c.recoY = y;
  return c;
}

void paintSheen(HDC hdc, int W) {
  Gdiplus::Graphics gfx(hdc);
  Gdiplus::LinearGradientBrush top(
      Gdiplus::Point(0, 0), Gdiplus::Point(0, S(64)),
      Gdiplus::Color(48, 255, 255, 255), Gdiplus::Color(0, 255, 255, 255));
  gfx.FillRectangle(&top, 0, 0, W, S(64));
  Gdiplus::LinearGradientBrush edge(
      Gdiplus::Point(0, 0), Gdiplus::Point(0, S(2)),
      Gdiplus::Color(90, 255, 255, 255), Gdiplus::Color(0, 255, 255, 255));
  gfx.FillRectangle(&edge, 0, 0, W, S(2));
}

void paintGlassFrame(HDC hdc, int W, int H) {
  HPEN pen = CreatePen(PS_SOLID, 1, kGlassLine);
  HPEN oldP = static_cast<HPEN>(SelectObject(hdc, pen));
  HBRUSH oldB = static_cast<HBRUSH>(SelectObject(hdc, GetStockObject(HOLLOW_BRUSH)));
  int rad = S(20);
  RoundRect(hdc, 0, 0, W - 1, H - 1, rad, rad);
  SelectObject(hdc, oldP);
  SelectObject(hdc, oldB);
  DeleteObject(pen);
}

// Corpo do paint sem Begin/EndPaint: o app vivo chama via paintPanel, e o
// --paint-check desenha o MESMO código num DIB em memória (janela offscreen
// não ganha superfície do compositor — BitBlt devolvia branco).
void paintPanelDC(HDC hdc, HWND hwndOrNull, int W, int H) {
  std::int64_t now = nowMs();
  ChromeBand band = measureChrome(hdc, H);
  int listTop = band.topH;
  int listBottom = H - band.bottomH;
  if (listBottom < listTop) listBottom = listTop;

  HBRUSH bgL = CreateSolidBrush(kBgList);
  RECT all = {0, 0, W, H};
  FillRect(hdc, &all, bgL);
  DeleteObject(bgL);

  // Lista primeiro. O cromo vem depois, opaco, para o rodapé nunca
  // vazar por cima da última conta.
  gListRc = {0, listTop, W, listBottom};
  int listH = listBottom - listTop;
  gContentH = measureContent(hdc, W, now);
  int maxScroll = gContentH > listH ? gContentH - listH : 0;
  if (gScrollY > maxScroll) gScrollY = maxScroll;
  if (gScrollY < 0) gScrollY = 0;
  SCROLLINFO si = {};
  si.cbSize = sizeof(si);
  si.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
  si.nMin = 0;
  si.nMax = gContentH;
  si.nPage = static_cast<UINT>(listH);
  si.nPos = gScrollY;
  if (hwndOrNull) SetScrollInfo(hwndOrNull, SB_VERT, &si, TRUE);

  int save = SaveDC(hdc);
  IntersectClipRect(hdc, 0, listTop, W, listBottom);
  Gdiplus::Graphics gfx(hdc);
  gfx.SetTextRenderingHint(Gdiplus::TextRenderingHintSystemDefault);
  int y = listTop - gScrollY;
  if (!g.hasSnap || !g.snap || g.snap->entries.empty()) {
    int x = S(16);
    int wrow = W - S(32);
    y += S(12);
    y += drawWrapped(hdc, L"Sem dados ainda.", gFonts.fBody, kTextDim, x, y,
                     wrow, false);
    y += S(4);
    drawWrapped(hdc, L"Abra o Nexus e atualize as cotas para ver o painel.",
                gFonts.fSmall, kTextFaint, x, y, wrow, false);
  } else {
    size_t last = g.snap->entries.size() - 1;
    for (size_t i = 0; i < g.snap->entries.size(); ++i) {
      int rh = drawEntry(hdc, &gfx, g.snap->entries[i], 0, y, W, false, now);
      if (i != last) {
        HBRUSH sep = CreateSolidBrush(kHairline);
        RECT sr = {S(16), y + rh - 1, W - S(16), y + rh};
        FillRect(hdc, &sr, sep);
        DeleteObject(sep);
      }
      y += rh;
    }
  }
  RestoreDC(hdc, save);

  // Cromo por cima da lista, com fundo próprio: título, resumo e folga
  // ficam cada um na sua linha, e a última conta não aparece por baixo.
  HBRUSH bgH = CreateSolidBrush(kBgHeader);
  RECT topR = {0, 0, W, listTop};
  RECT botR = {0, listBottom, W, H};
  FillRect(hdc, &topR, bgH);
  FillRect(hdc, &botR, bgH);
  DeleteObject(bgH);
  paintSheen(hdc, W);
  HBRUSH hair = CreateSolidBrush(kGlassLine);
  RECT h1 = {S(14), listTop - 1, W - S(14), listTop};
  RECT h2 = {S(14), listBottom, W - S(14), listBottom + 1};
  FillRect(hdc, &h1, hair);
  FillRect(hdc, &h2, hair);
  DeleteObject(hair);

  const int hx = S(16);
  const int hw = W - S(32);
  const int gapBtn = S(8);
  const int bw = (W - S(32) - gapBtn) / 2;
  gLoginRc = {hx, band.row1Y, hx + S(230), band.row1Y + band.row1H};
  gQuitRc = {W - S(16) - S(64), band.row1Y, W - S(16), band.row1Y + band.row1H};
  gRefreshRc = {hx, band.row2Y, hx + bw, band.row2Y + band.row2H};
  gOpenRc = {W - S(16) - bw, band.row2Y, W - S(16), band.row2Y + band.row2H};
  paintButton(hdc, gRefreshRc, L"Atualizar agora", true,
              gHover == Ctl::Refresh, gFocus == Ctl::Refresh);
  paintButton(hdc, gOpenRc, L"Abrir no Nexus", false, gHover == Ctl::Open,
              gFocus == Ctl::Open);
  paintCheckbox(hdc, gLoginRc, g.launchAtLogin, gHover == Ctl::Login,
                gFocus == Ctl::Login);
  paintGhost(hdc, gQuitRc, L"Sair", gHover == Ctl::Quit, gFocus == Ctl::Quit);

  drawSingleLine(hdc, L"Nexus Redline", gFonts.fTitle, kText, hx, band.titleY, hw);
  std::wstring summary;
  std::wstring reco;
  COLORREF recoInk = kTextDim;
  bool splitReco = false;
  if (g.hasSnap && g.snap && !g.snap->entries.empty()) {
    const auto& snap = *g.snap;
    size_t prov = 0;
    std::vector<std::string> seen;
    for (const auto& e : snap.entries) {
      bool found = false;
      for (const auto& s : seen) {
        if (s == e.adapterId) {
          found = true;
          break;
        }
      }
      if (!found) {
        seen.push_back(e.adapterId);
        ++prov;
      }
    }
    size_t n = snap.entries.size();
    wchar_t buf[160];
    swprintf_s(buf, L"%zu %s \u00B7 %zu %s", prov,
               prov == 1 ? L"provedor" : L"provedores", n,
               n == 1 ? L"conta" : L"contas");
    summary = buf;
    summary += L" \u00B7 atualizado " + toWide(redline::ageLabel(snap.updatedAt, now));
    if (redline::isStale(snap, now)) summary += L" \u00B7 Nexus offline";
    auto best = redline::bestRankingPick(snap);
    if (best) {
      char pct[16];
      std::snprintf(pct, sizeof(pct), "%d%%",
                    static_cast<int>(std::lround(best->row.headroom * 100.0)));
      std::string providerLabel = redline::providerName(best->adapterId);
      reco = L"Mais folga: " + toWide(providerLabel);
      if (!best->row.label.empty() &&
          _stricmp(best->row.label.c_str(), providerLabel.c_str()) != 0) {
        reco += L" \u00B7 " + toWide(best->row.label);
      }
      reco += L" \u00B7 " + toWide(pct);
      recoInk = kOk;
      splitReco = true;
    } else {
      reco = L"Uso por conta \u00B7 role para ver todas";
    }
  } else {
    summary = L"0 provedores \u00B7 0 contas \u00B7 abra o Nexus para carregar";
    reco = L"Uso por conta \u00B7 role para ver todas";
  }
  if (summary.find(L"Nexus offline") != std::wstring::npos) {
    std::wstring head = summary.substr(0, summary.size() - std::wstring(L"Nexus offline").size());
    int sw = textWidth(hdc, head, gFonts.fSmall);
    if (sw > hw) sw = hw;
    drawSingleLine(hdc, head, gFonts.fSmall, kTextDim, hx, band.summaryY, hw);
    if (sw < hw) {
      drawSingleLine(hdc, L"Nexus offline", gFonts.fSmall, kWarn, hx + sw,
                     band.summaryY, hw - sw);
    }
  } else {
    drawSingleLine(hdc, summary, gFonts.fSmall, kTextDim, hx, band.summaryY, hw);
  }
  if (splitReco) {
    size_t sep = reco.rfind(L" \u00B7 ");
    std::wstring head = sep == std::wstring::npos ? reco : reco.substr(0, sep + 3);
    std::wstring tail = sep == std::wstring::npos ? L"" : reco.substr(sep + 3);
    int headW = textWidth(hdc, head, gFonts.fSmall);
    if (headW > hw) headW = hw;
    drawSingleLine(hdc, head, gFonts.fSmall, kTextDim, hx, band.recoY,
                   headW < hw ? headW : hw);
    if (headW < hw && !tail.empty()) {
      drawSingleLine(hdc, tail, gFonts.fSmallSB, recoInk, hx + headW, band.recoY,
                     hw - headW);
    }
  } else {
    drawSingleLine(hdc, reco, gFonts.fSmall, recoInk, hx, band.recoY, hw);
  }
  paintGlassFrame(hdc, W, H);
}

void paintPanel(HWND hwnd) {
  PAINTSTRUCT ps;
  HDC hdc = BeginPaint(hwnd, &ps);
  RECT client;
  GetClientRect(hwnd, &client);
  paintPanelDC(hdc, hwnd, client.right, client.bottom);
  EndPaint(hwnd, &ps);
}

// â”€â”€ AÃ§Ãµes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

void doRefresh() {
  redline::writeRefreshRequest(g.homeUtf8, nowMs());
  if (snapshotChangedOnDisk()) reloadSnapshot();
  refreshTray();
  if (g.panelWnd) InvalidateRect(g.panelWnd, nullptr, FALSE);
}

void doOpenNexus() {
  ShellExecuteW(nullptr, L"open", L"nexus://quota", nullptr, nullptr,
                SW_SHOWNORMAL);
}

void doToggleLogin() {
  setAutostart(!g.launchAtLogin);
  g.launchAtLogin = autostartEnabled();
  if (g.panelWnd) InvalidateRect(g.panelWnd, nullptr, FALSE);
}

void activateCtl(Ctl c) {
  switch (c) {
    case Ctl::Refresh: doRefresh(); break;
    case Ctl::Open: doOpenNexus(); break;
    case Ctl::Login: doToggleLogin(); break;
    case Ctl::Quit: PostQuitMessage(0); break;
    case Ctl::None: break;
  }
}

Ctl hitTest(int x, int y) {
  POINT p = {x, y};
  if (PtInRect(&gRefreshRc, p)) return Ctl::Refresh;
  if (PtInRect(&gOpenRc, p)) return Ctl::Open;
  if (PtInRect(&gLoginRc, p)) return Ctl::Login;
  if (PtInRect(&gQuitRc, p)) return Ctl::Quit;
  return Ctl::None;
}

void cycleFocus(bool back) {
  const Ctl order[] = {Ctl::Refresh, Ctl::Open, Ctl::Login, Ctl::Quit};
  int idx = 0;
  for (int i = 0; i < 4; ++i) {
    if (order[i] == gFocus) {
      idx = i;
      break;
    }
  }
  idx = (idx + (back ? 3 : 1)) % 4;
  gFocus = order[static_cast<size_t>(idx)];
  if (g.panelWnd) InvalidateRect(g.panelWnd, nullptr, FALSE);
}

// â”€â”€ Painel popup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

void clipPanelShape(HWND w) {
  RECT rc{};
  if (!GetWindowRect(w, &rc)) return;
  int width = rc.right - rc.left;
  int height = rc.bottom - rc.top;
  if (width < 2 || height < 2) return;
  int rad = S(22);
  HRGN rgn = CreateRoundRectRgn(0, 0, width + 1, height + 1, rad, rad);
  if (rgn) SetWindowRgn(w, rgn, TRUE);
}

// Vidro líquido: acrílico do DWM por baixo e a janela levemente translúcida,
// para o blur aparecer através da tinta escura. Sem isto o FillRect opaco
// cobre o material e o painel volta a ser uma chapa.
void applyLiquidGlass(HWND w) {
  const DWORD corner = 2;  // DWMWCP_ROUND
  DwmSetWindowAttribute(w, 33 /*DWMWA_WINDOW_CORNER_PREFERENCE*/, &corner,
                        sizeof(corner));
  const DWORD backdrop = 3;  // DWMSBT_TRANSIENTWINDOW (acrílico Win11)
  DwmSetWindowAttribute(w, 38 /*DWMWA_SYSTEMBACKDROP_TYPE*/, &backdrop,
                        sizeof(backdrop));
  struct AccentPolicy {
    int state;
    int flags;
    DWORD color;
    int animation;
  } policy{4, 2, 0xE6100E14, 0};  // acrylic, AABBGGRR ~ #14100E a 90%
  struct CompData {
    DWORD attribute;
    void* data;
    SIZE_T size;
  } data{19, &policy, sizeof(policy)};
  if (HMODULE user = GetModuleHandleW(L"user32.dll")) {
    using Fn = BOOL(WINAPI*)(HWND, CompData*);
    auto fn = reinterpret_cast<Fn>(
        GetProcAddress(user, "SetWindowCompositionAttribute"));
    if (fn) fn(w, &data);
  }
  SetLayeredWindowAttributes(w, 0, 214, LWA_ALPHA);
  clipPanelShape(w);
}

void closePanel() {
  if (!g.panelWnd) return;
  HWND w = g.panelWnd;
  g.panelWnd = nullptr;
  DestroyWindow(w);
}

void showPanel() {
  if (g.panelWnd) {
    closePanel();
    return;
  }
  reloadSnapshot();
  g.launchAtLogin = autostartEnabled();
  gScrollY = 0;
  gFocus = Ctl::Refresh;
  gHover = Ctl::None;

  // DPI do monitor onde o painel vai abrir.
  HMONITOR mon = MonitorFromPoint({GetSystemMetrics(SM_CXSCREEN) / 2,
                                   GetSystemMetrics(SM_CYSCREEN) / 2},
                                  MONITOR_DEFAULTTONEAREST);
  UINT dpiX = 96;
  UINT dpiY = 96;
  HMODULE shcore = LoadLibraryW(L"shcore.dll");
  if (shcore) {
    using GetDpiFn = HRESULT(WINAPI*)(HMONITOR, int, UINT*, UINT*);
    auto fn = reinterpret_cast<GetDpiFn>(
        GetProcAddress(shcore, "GetDpiForMonitor"));
    if (fn) fn(mon, 0 /*MDT_EFFECTIVE_DPI*/, &dpiX, &dpiY);
    FreeLibrary(shcore);
  }
  gDpi = static_cast<int>(dpiX);
  destroyFonts();
  initFonts();

  const int W = S(kPanelW);
  const int H = panelHeightFor(g.trayWnd);
  // Ã‚ncora: tenta o retÃ¢ngulo real do Ã­cone; cai para a Ã¡rea de trabalho.
  RECT anchor = {};
  bool hasAnchor = false;
  HMODULE shell = LoadLibraryW(L"shell32.dll");
  if (shell) {
    using RectFn = HRESULT(WINAPI*)(const NOTIFYICONIDENTIFIER*, RECT*);
    auto fn =
        reinterpret_cast<RectFn>(GetProcAddress(shell, "Shell_NotifyIconGetRect"));
    if (fn) {
      NOTIFYICONIDENTIFIER id = {};
      id.cbSize = sizeof(id);
      id.hWnd = g.trayWnd;
      id.uID = kTrayIconId;
      if (SUCCEEDED(fn(&id, &anchor))) hasAnchor = true;
    }
    FreeLibrary(shell);
  }
  MONITORINFO mi = {};
  mi.cbSize = sizeof(mi);
  GetMonitorInfoW(mon, &mi);
  int x = mi.rcWork.right - W - S(8);
  int y = mi.rcWork.bottom - H - S(8);
  if (hasAnchor) {
    x = anchor.left + (anchor.right - anchor.left) / 2 - W / 2;
    if (anchor.bottom >= mi.rcWork.bottom - S(8))
      y = anchor.top - H - S(4);  // barra embaixo: painel acima
    else if (anchor.top <= mi.rcWork.top + S(8))
      y = anchor.bottom + S(4);  // barra em cima: painel abaixo
    else
      y = anchor.top - H - S(4);
    if (x + W > mi.rcWork.right) x = mi.rcWork.right - W;
    if (x < mi.rcWork.left) x = mi.rcWork.left;
    if (y + H > mi.rcWork.bottom) y = mi.rcWork.bottom - H;
    if (y < mi.rcWork.top) y = mi.rcWork.top;
  }

  HWND w = CreateWindowExW(
      WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_LAYERED, L"NexusRedlinePanel",
      L"Nexus Redline", WS_POPUP | WS_VSCROLL | WS_CLIPCHILDREN, x, y, W, H,
      nullptr, nullptr, g.inst, nullptr);
  if (!w) return;
  applyLiquidGlass(w);
  g.panelWnd = w;
  gPanelEverOpened = true;
  // Ativa de propÃ³sito (igual ao popover makeKey do Mac): Esc/R/O/Q/Tab
  // e o foco visÃ­vel sÃ³ funcionam com a janela ativa; ela fecha sozinha
  // ao perder a ativaÃ§Ã£o (transient).
  ShowWindow(w, SW_SHOW);
  SetForegroundWindow(w);
  SetFocus(w);
}

LRESULT CALLBACK panelProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT:
      paintPanel(hwnd);
      return 0;
    case WM_LBUTTONDOWN: {
      int x = GET_X_LPARAM(lp);
      int y = GET_Y_LPARAM(lp);
      Ctl c = hitTest(x, y);
      if (c != Ctl::None) {
        gFocus = c;
        activateCtl(c);
      }
      SetFocus(hwnd);
      return 0;
    }
    case WM_MOUSEMOVE: {
      int x = GET_X_LPARAM(lp);
      int y = GET_Y_LPARAM(lp);
      Ctl c = PtInRect(&gListRc, {x, y}) ? Ctl::None : hitTest(x, y);
      if (c != gHover) {
        gHover = c;
        InvalidateRect(hwnd, nullptr, FALSE);
        if (c != Ctl::None) {
          TRACKMOUSEEVENT t = {};
          t.cbSize = sizeof(t);
          t.dwFlags = TME_LEAVE;
          t.hwndTrack = hwnd;
          TrackMouseEvent(&t);
        }
      }
      return 0;
    }
    case WM_MOUSELEAVE:
      gHover = Ctl::None;
      InvalidateRect(hwnd, nullptr, FALSE);
      return 0;
    case WM_MOUSEWHEEL: {
      int delta = GET_WHEEL_DELTA_WPARAM(wp);
      gScrollY -= (delta * S(40)) / WHEEL_DELTA;
      InvalidateRect(hwnd, nullptr, FALSE);
      return 0;
    }
    case WM_VSCROLL: {
      int listH = gListRc.bottom - gListRc.top;
      int maxScroll = gContentH > listH ? gContentH - listH : 0;
      int line = S(20);
      switch (LOWORD(wp)) {
        case SB_LINEUP: gScrollY -= line; break;
        case SB_LINEDOWN: gScrollY += line; break;
        case SB_PAGEUP: gScrollY -= listH; break;
        case SB_PAGEDOWN: gScrollY += listH; break;
        case SB_THUMBTRACK:
        case SB_THUMBPOSITION: gScrollY = static_cast<int>(HIWORD(wp)); break;
        default: break;
      }
      if (gScrollY > maxScroll) gScrollY = maxScroll;
      if (gScrollY < 0) gScrollY = 0;
      SetScrollPos(hwnd, SB_VERT, gScrollY, TRUE);
      InvalidateRect(hwnd, nullptr, FALSE);
      return 0;
    }
    case WM_KEYDOWN:
      switch (wp) {
        case VK_ESCAPE:
        case 'Q': closePanel(); return 0;
        case 'R': activateCtl(Ctl::Refresh); return 0;
        case 'O': activateCtl(Ctl::Open); return 0;
        case VK_TAB:
          cycleFocus((GetKeyState(VK_SHIFT) & 0x8000) != 0);
          return 0;
        case VK_SPACE:
        case VK_RETURN: activateCtl(gFocus); return 0;
        case VK_UP: gFocus = Ctl::Refresh; break;
        case VK_DOWN: gFocus = Ctl::Quit; break;
        default: break;
      }
      InvalidateRect(hwnd, nullptr, FALSE);
      return 0;
    case WM_ACTIVATE:
      if (LOWORD(wp) == WA_INACTIVE) closePanel();
      return 0;
    case WM_DPICHANGED: {
      RECT* rc = reinterpret_cast<RECT*>(lp);
      gDpi = static_cast<int>(HIWORD(wp));
      destroyFonts();
      initFonts();
      SetWindowPos(hwnd, nullptr, rc->left, rc->top, rc->right - rc->left,
                   rc->bottom - rc->top, SWP_NOZORDER | SWP_NOACTIVATE);
      clipPanelShape(hwnd);
      InvalidateRect(hwnd, nullptr, TRUE);
      return 0;
    }
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

// â”€â”€ Watch do diretÃ³rio ~/.nexus â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

HANDLE gStopWatch = nullptr;

DWORD WINAPI watchProc(LPVOID) {
  g.dirChange = FindFirstChangeNotificationW(
      g.homeW.c_str(), FALSE,
      FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_FILE_NAME);
  if (!g.dirChange || g.dirChange == INVALID_HANDLE_VALUE) {
    // Sem watch do diretório o poll de 2s cobre; só aguarda a parada.
    g.dirChange = nullptr;
    WaitForSingleObject(gStopWatch, INFINITE);
    return 0;
  }
  HANDLE wait[2] = {g.dirChange, gStopWatch};
  for (;;) {
    DWORD r = WaitForMultipleObjects(2, wait, FALSE, INFINITE);
    if (r != WAIT_OBJECT_0) break;  // parada ou falha → encerra
    if (!FindNextChangeNotification(g.dirChange)) break;
    PostMessageW(g.trayWnd, kReloadMsg, 0, 0);
    // Coalesce: o Nexus escreve snapshot + refresh em sequÃªncia.
    Sleep(250);
  }
  return 0;
}

// â”€â”€ Janela dona da bandeja â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

UINT gTaskbarCreated = 0;
// Segunda instância (duplo clique no exe, "Abrir") pede o painel em vez de
// sair calada no mutex. 0 até RegisterWindowMessage.
UINT gOpenPanelMsg = 0;
// Segura o mutex pela vida do processo. Fechar o handle libera o nome.
HANDLE gInstanceMutex = nullptr;

void revealPanel() {
  if (g.panelWnd) {
    ShowWindow(g.panelWnd, SW_SHOW);
    SetForegroundWindow(g.panelWnd);
    return;
  }
  showPanel();
}

LRESULT CALLBACK trayProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == gTaskbarCreated) {
    addTrayIcon();
    refreshTray();
    return 0;
  }
  if (gOpenPanelMsg != 0 && msg == gOpenPanelMsg) {
    revealPanel();
    return 0;
  }
  switch (msg) {
    case kTrayCallbackMsg:
      if (LOWORD(lp) == NIN_SELECT || LOWORD(lp) == WM_LBUTTONUP)
        showPanel();
      else if (LOWORD(lp) == WM_RBUTTONUP)
        showPanel();
      return 0;
    case kReloadMsg:
      if (snapshotChangedOnDisk()) reloadSnapshot();
      refreshTray();
      if (g.panelWnd) InvalidateRect(g.panelWnd, nullptr, FALSE);
      return 0;
    case WM_TIMER:
      if (wp == kPollTimer) {
        // O shell só cria a chave do ícone depois do NIM_ADD.
        if (!gTrayPromoted) gTrayPromoted = promoteTrayIcon();
        // Poll de 2s: rede de seguranÃ§a (rename atÃ´mico) + countdowns.
        if (snapshotChangedOnDisk()) reloadSnapshot();
        refreshTray();
        if (g.panelWnd) InvalidateRect(g.panelWnd, nullptr, FALSE);
      } else if (wp == 9876) {
        // Abertura real (clique/"Abrir") e seam --toggle-panel: o painel
        // abre pelo showPanel(); só o probe agenda a saída.
        KillTimer(hwnd, 9876);
        showPanel();
        if (gTogglePanelProbe) SetTimer(hwnd, 9877, 2500, nullptr);
      } else if (wp == 9877) {
        PostQuitMessage(0);
      }
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

// â”€â”€ Bootstrap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

void writeStdout(const std::string& s) {
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  if (h && h != INVALID_HANDLE_VALUE) {
    DWORD done = 0;
    WriteFile(h, s.data(), static_cast<DWORD>(s.size()), &done, nullptr);
  }
}

int runSelfTest() {
  AttachConsole(ATTACH_PARENT_PROCESS);
  std::string report;
  bool ok = redline::runSelfTests(report);
  // Checagem ponta a ponta: fixture real no disco via NEXUS_REDLINE_HOME.
  wchar_t tmp[MAX_PATH];
  if (GetTempPathW(MAX_PATH, tmp)) {
    std::wstring dir = std::wstring(tmp) + L"redline-selftest";
    CreateDirectoryW(dir.c_str(), nullptr);
    std::wstring snap = dir + L"\\redline-last-good.json";
    HANDLE h = CreateFileW(snap.c_str(), GENERIC_WRITE, 0, nullptr,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
      const char* mini =
          "{\"formatVersion\":1,\"generatedBy\":\"nexus\",\"updatedAt\":1,"
          "\"entries\":[{\"id\":\"kimi:a\",\"adapterId\":\"kimi\","
          "\"label\":\"K\",\"windows\":[]}]}";
      DWORD done = 0;
      WriteFile(h, mini, static_cast<DWORD>(strlen(mini)), &done, nullptr);
      CloseHandle(h);
      int n = WideCharToMultiByte(CP_UTF8, 0, dir.c_str(), -1, nullptr, 0,
                                  nullptr, nullptr);
      if (n > 0) {
        std::string utf8(static_cast<size_t>(n) - 1, '\0');
        WideCharToMultiByte(CP_UTF8, 0, dir.c_str(), -1, utf8.data(), n,
                            nullptr, nullptr);
        auto loaded = redline::loadSnapshotFile(utf8 + "/redline-last-good.json");
        if (!loaded || loaded->entries.size() != 1 ||
            loaded->entries[0].adapterId != "kimi") {
          report += "[FALHOU] roundtrip do snapshot no disco\n";
          ok = false;
        } else {
          report += "[ok] roundtrip do snapshot no disco\n";
        }
      }
      DeleteFileW(snap.c_str());
      RemoveDirectoryW(dir.c_str());
    }
  }
  if (!ok && report.find("REDLINE WINDOWS CHECKS FAILED") == std::string::npos)
    report += "REDLINE WINDOWS CHECKS FAILED\n";
  writeStdout(report);
  return ok ? 0 : 1;
}

// ── Paint-check (verificação headless do painel) ─────────────────────────────
// Abre o painel REAL fora da tela, força WM_PAINT síncrono e salva BMPs.
// Exercita fontes, logos, layout, scroll e todos os ramos de linha sem
// precisar clicar na bandeja. Uso: --paint-check <snapshot> <bmp1> [bmp2].
// O segundo BMP sai com a lista rolada à metade (prova o path de scroll).
// BMP de 24bpp escrito à mão (sem encoder externo): determinístico.
// O DIB é top-down (linhas na ordem de pintura); o arquivo sai bottom-up.
bool saveDibBmp(const unsigned char* topDown, int w, int h,
                const std::wstring& path) {
  const int stride = ((w * 3 + 3) & ~3);
  unsigned char fileHead[14] = {'B', 'M', 0, 0, 0, 0, 0, 0,
                                0,   0,   54, 0,  0,  0};
  unsigned size =
      54 + static_cast<unsigned>(stride) * static_cast<unsigned>(h);
  fileHead[2] = static_cast<unsigned char>(size & 0xFF);
  fileHead[3] = static_cast<unsigned char>((size >> 8) & 0xFF);
  fileHead[4] = static_cast<unsigned char>((size >> 16) & 0xFF);
  fileHead[5] = static_cast<unsigned char>((size >> 24) & 0xFF);
  unsigned char infoHead[40] = {};
  infoHead[0] = 40;
  infoHead[4] = static_cast<unsigned char>(w & 0xFF);
  infoHead[5] = static_cast<unsigned char>((w >> 8) & 0xFF);
  infoHead[8] = static_cast<unsigned char>(h & 0xFF);
  infoHead[9] = static_cast<unsigned char>((h >> 8) & 0xFF);
  infoHead[12] = 1;  // planes
  infoHead[14] = 24;  // bitcount
  HANDLE f = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                         CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  DWORD done = 0;
  BOOL ok = WriteFile(f, fileHead, sizeof(fileHead), &done, nullptr) &&
            WriteFile(f, infoHead, sizeof(infoHead), &done, nullptr);
  for (int y = h - 1; ok && y >= 0; --y) {
    ok = WriteFile(f, topDown + static_cast<size_t>(y) * static_cast<size_t>(stride),
                   static_cast<DWORD>(stride), &done, nullptr);
  }
  CloseHandle(f);
  return ok != FALSE;
}

unsigned long long fnv1a(const unsigned char* data, size_t len) {
  unsigned long long h = 1469598103934665603ULL;
  for (size_t i = 0; i < len; ++i) {
    h ^= data[i];
    h *= 1099511628211ULL;
  }
  return h;
}

int runPaintCheck(const std::wstring& snapPath, const std::wstring& out1,
                  const std::wstring& out2) {
  // Mesmo caminho de dados do app vivo: snapshot do disco + logos do bundle.
  std::string snapUtf8;
  {
    int n = WideCharToMultiByte(CP_UTF8, 0, snapPath.c_str(), -1, nullptr, 0,
                                nullptr, nullptr);
    if (n <= 0) return 1;
    snapUtf8.assign(static_cast<size_t>(n) - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, snapPath.c_str(), -1, snapUtf8.data(), n,
                        nullptr, nullptr);
  }
  auto snap = redline::loadSnapshotFile(snapUtf8);
  g.hasSnap = snap.has_value();
  g.snap = std::move(snap);
  g.logoDir = exeDir();
  std::vector<std::pair<std::string, LogoManifestEntry>> logos;
  if (loadLogoManifest(g.logoDir, logos)) g.logos = std::move(logos);

  gDpi = 96;  // determinístico
  initFonts();

  const int W = S(kPanelW);
  const int H = panelHeightFor(nullptr);
  // DIB top-down em memória: o MESMO paintPanelDC do app vivo, sem janela.
  BITMAPINFO bi = {};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = W;
  bi.bmiHeader.biHeight = -H;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 24;
  bi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HDC screen = GetDC(nullptr);
  HBITMAP dib =
      CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  HDC mem = CreateCompatibleDC(screen);
  ReleaseDC(nullptr, screen);
  if (!dib || !mem) {
    if (dib) DeleteObject(dib);
    if (mem) DeleteDC(mem);
    return 1;
  }
  HBITMAP old = static_cast<HBITMAP>(SelectObject(mem, dib));
  paintPanelDC(mem, nullptr, W, H);
  bool ok = saveDibBmp(static_cast<unsigned char*>(bits), W, H, out1);
  // Segunda captura com scroll: prova o path de rolagem/separadores.
  if (ok && !out2.empty()) {
    gScrollY = gContentH / 2;
    paintPanelDC(mem, nullptr, W, H);
    ok = saveDibBmp(static_cast<unsigned char*>(bits), W, H, out2);
  }
  SelectObject(mem, old);
  DeleteObject(dib);
  DeleteDC(mem);
  // Checksum FNV sobre o BMP para o teste amarrar o render.
  unsigned long long sum = 0;
  if (ok) {
    HANDLE f = CreateFileW(out1.c_str(), GENERIC_READ, FILE_SHARE_READ,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                           nullptr);
    if (f != INVALID_HANDLE_VALUE) {
      DWORD size = GetFileSize(f, nullptr);
      if (size != INVALID_FILE_SIZE && size < 32 * 1024 * 1024) {
        std::vector<unsigned char> bytes(size);
        DWORD read = 0;
        if (ReadFile(f, bytes.data(), size, &read, nullptr))
          sum = fnv1a(bytes.data(), read);
      }
      CloseHandle(f);
    }
  }
  destroyFonts();
  gLogoCache.imgs.clear();
  if (!ok) return 1;
  char buf[96];
  std::snprintf(buf, sizeof(buf), "paint-check %dx%d fnv=%llx\n", W, H, sum);
  writeStdout(buf);
  return 0;
}

// true = esta instância é a dona. false = já havia uma; o painel dela foi
// pedido e o chamador deve sair.
bool claimSingleInstance() {
  gOpenPanelMsg = RegisterWindowMessageW(L"NexusRedline-OpenPanel");
  gInstanceMutex = CreateMutexW(
      nullptr, FALSE, L"NexusRedline-9f3a7c2e-single-instance");
  if (gInstanceMutex && GetLastError() != ERROR_ALREADY_EXISTS) return true;
  if (gOpenPanelMsg != 0) {
    // Quem acabou de abrir este exe é o foreground: libera o processo que
    // já está na bandeja a trazer o painel para a frente.
    AllowSetForegroundWindow(ASFW_ANY);
    if (HWND existing =
            FindWindowW(L"NexusRedlineTray", L"Nexus Redline Tray")) {
      PostMessageW(existing, gOpenPanelMsg, 0, 0);
    }
  }
  if (gInstanceMutex) {
    CloseHandle(gInstanceMutex);
    gInstanceMutex = nullptr;
  }
  return false;
}

}  // namespace — wWinMain tem linkage externo (o CRT o referencia).

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, LPWSTR cmd, int) {
  g.inst = inst;
  if (wcsstr(cmd, L"--self-test")) return runSelfTest();
  {
    // --paint-check <snapshot> <bmp1> [bmp2]: render offscreen do painel.
    // --toggle-panel: abre o painel pelo showPanel() real e sai em ~3s.
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv) {
      int rc = -1;
      for (int i = 1; i < argc; ++i) {
        if (wcscmp(argv[i], L"--toggle-panel") == 0) {
          gTogglePanelProbe = true;
          break;
        }
        if (wcscmp(argv[i], L"--paint-check") == 0) {
          std::wstring snap = (i + 1 < argc) ? argv[i + 1] : L"";
          std::wstring out1 = (i + 2 < argc) ? argv[i + 2] : L"";
          std::wstring out2 = (i + 3 < argc) ? argv[i + 3] : L"";
          if (!snap.empty() && !out1.empty()) {
            Gdiplus::GdiplusStartupInput gpsi;
            ULONG_PTR token = 0;
            bool gdi = Gdiplus::GdiplusStartup(&token, &gpsi, nullptr) ==
                       Gdiplus::Ok;
            rc = runPaintCheck(snap, out1, out2);
            if (gdi) Gdiplus::GdiplusShutdown(token);
          } else {
            rc = 2;
          }
          break;
        }
      }
      LocalFree(argv);
      if (rc >= 0) return rc;
    }
  }

  if (!claimSingleInstance()) return 0;

  // Per-monitor DPI (o painel ancora na bandeja, que pode estar em outro
  // monitor). Falha aqui sÃ³ perde nitidez, nÃ£o funÃ§Ã£o.
  if (HMODULE u32 = LoadLibraryW(L"user32.dll")) {
    using CtxFn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
    auto fn = reinterpret_cast<CtxFn>(
        GetProcAddress(u32, "SetProcessDpiAwarenessContext"));
    if (fn) fn(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    FreeLibrary(u32);
  }

  Gdiplus::GdiplusStartupInput gpsi;
  if (Gdiplus::GdiplusStartup(&g.gdiplusToken, &gpsi, nullptr) !=
      Gdiplus::Ok)
    return 1;

  g.homeUtf8 = redline::redlineHomeDirUtf8();
  g.homeW = toWide(g.homeUtf8);
  g.snapPathW = toWide(redline::snapshotPathForHome(g.homeUtf8));
  g.logoDir = exeDir();
  std::vector<std::pair<std::string, LogoManifestEntry>> logos;
  if (loadLogoManifest(g.logoDir, logos)) g.logos = std::move(logos);
  g.launchAtLogin = autostartEnabled();

  gTaskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");

  WNDCLASSW trayClass = {};
  trayClass.lpfnWndProc = trayProc;
  trayClass.hInstance = inst;
  trayClass.lpszClassName = L"NexusRedlineTray";
  RegisterClassW(&trayClass);

  WNDCLASSW panelClass = {};
  panelClass.lpfnWndProc = panelProc;
  panelClass.hInstance = inst;
  panelClass.lpszClassName = L"NexusRedlinePanel";
  panelClass.hbrBackground = CreateSolidBrush(kBgList);
  panelClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  RegisterClassW(&panelClass);

  gDpi = 96;
  if (HMONITOR mon =
          MonitorFromPoint({GetSystemMetrics(SM_CXSCREEN) / 2,
                            GetSystemMetrics(SM_CYSCREEN) / 2},
                           MONITOR_DEFAULTTONEAREST)) {
    UINT dx = 96;
    UINT dy = 96;
    if (HMODULE shcore = LoadLibraryW(L"shcore.dll")) {
      using GetDpiFn = HRESULT(WINAPI*)(HMONITOR, int, UINT*, UINT*);
      auto fn = reinterpret_cast<GetDpiFn>(
          GetProcAddress(shcore, "GetDpiForMonitor"));
      if (fn) fn(mon, 0, &dx, &dy);
      FreeLibrary(shcore);
    }
    gDpi = static_cast<int>(dx);
  }
  initFonts();

  g.trayWnd = CreateWindowExW(0, L"NexusRedlineTray", L"Nexus Redline Tray",
                              WS_OVERLAPPED, 0, 0, 0, 0, nullptr, nullptr,
                              inst, nullptr);
  if (!g.trayWnd) return 1;

  reloadSnapshot();
  if (snapshotChangedOnDisk()) reloadSnapshot();
  addTrayIcon();
  refreshTray();
  if (wcsstr(cmd, L"--first-run")) showFirstRunBalloon();

  gStopWatch = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  g.watchThread = CreateThread(nullptr, 0, watchProc, nullptr, 0,
                               &g.watchThreadId);
  SetTimer(g.trayWnd, kPollTimer, kPollMs, nullptr);
  // Abertura do painel: --open-panel ("Abrir" no Nexus) abre e fica;
  // --toggle-panel (seam de teste) abre e sai sozinho (~3s).
  // Id literal 9876 espelha o trayProc; constexpr aqui viraria variável
  // não referenciada (/WX).
  if (gTogglePanelProbe || wcsstr(cmd, L"--open-panel"))
    SetTimer(g.trayWnd, 9876, 500, nullptr);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0)) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  KillTimer(g.trayWnd, kPollTimer);
  if (gStopWatch) SetEvent(gStopWatch);
  if (g.watchThread) {
    WaitForSingleObject(g.watchThread, 3000);
    CloseHandle(g.watchThread);
  }
  if (gStopWatch) CloseHandle(gStopWatch);
  if (g.dirChange && g.dirChange != INVALID_HANDLE_VALUE)
    FindCloseChangeNotification(g.dirChange);
  closePanel();
  NOTIFYICONDATAW nid = {};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g.trayWnd;
  nid.uID = kTrayIconId;
  Shell_NotifyIconW(NIM_DELETE, &nid);
  if (g.trayIcon) DestroyIcon(g.trayIcon);
  destroyFonts();
  gLogoCache.imgs.clear();
  Gdiplus::GdiplusShutdown(g.gdiplusToken);
  if (gTogglePanelProbe) {
    // Prova do --toggle-panel: o painel abriu de verdade pelo showPanel().
    writeStdout(gPanelEverOpened ? "toggle-panel opened\n"
                                 : "toggle-panel FAILED\n");
    return gPanelEverOpened ? 0 : 1;
  }
  return 0;
}
