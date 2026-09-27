// Nexus Redline (Windows) — parser JSON + montagem do snapshot.
// Sem dependências além da STL (ver redline-model.h).

#include "redline-model.h"

#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>

#ifdef _WIN32
#include <windows.h>
#endif

namespace redline {
namespace {

const JsonValue kMissing;  // Null estático para lookup sem achado.

class Parser {
 public:
  explicit Parser(const std::string& text) : s_(text) {}

  std::optional<JsonValue> run() {
    skipWs();
    auto v = parseValue();
    if (!v) return std::nullopt;
    skipWs();
    if (pos_ != s_.size()) return std::nullopt;  // lixo após o valor
    return v;
  }

 private:
  const std::string& s_;
  size_t pos_ = 0;

  void skipWs() {
    while (pos_ < s_.size()) {
      char c = s_[pos_];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r')
        ++pos_;
      else
        break;
    }
  }
  bool consume(char c) {
    if (pos_ < s_.size() && s_[pos_] == c) {
      ++pos_;
      return true;
    }
    return false;
  }
  bool consumeLiteral(const char* word) {
    size_t i = 0;
    while (word[i]) {
      if (pos_ + i >= s_.size() || s_[pos_ + i] != word[i]) return false;
      ++i;
    }
    pos_ += i;
    return true;
  }

  std::optional<JsonValue> parseValue() {
    if (pos_ >= s_.size()) return std::nullopt;
    char c = s_[pos_];
    if (c == '{') return parseObject();
    if (c == '[') return parseArray();
    if (c == '"') {
      auto str = parseString();
      if (!str) return std::nullopt;
      return JsonValue::makeString(std::move(*str));
    }
    if (c == 't') {
      if (!consumeLiteral("true")) return std::nullopt;
      return JsonValue::makeBool(true);
    }
    if (c == 'f') {
      if (!consumeLiteral("false")) return std::nullopt;
      return JsonValue::makeBool(false);
    }
    if (c == 'n') {
      if (!consumeLiteral("null")) return std::nullopt;
      return JsonValue::makeNull();
    }
    return parseNumber();
  }

  std::optional<JsonValue> parseObject() {
    ++pos_;  // {
    JsonObject obj;
    skipWs();
    if (consume('}')) return JsonValue::makeObject(std::move(obj));
    while (true) {
      skipWs();
      if (pos_ >= s_.size() || s_[pos_] != '"') return std::nullopt;
      auto key = parseString();
      if (!key) return std::nullopt;
      skipWs();
      if (!consume(':')) return std::nullopt;
      skipWs();
      auto val = parseValue();
      if (!val) return std::nullopt;
      obj.emplace_back(std::move(*key), std::move(*val));
      skipWs();
      if (consume('}')) return JsonValue::makeObject(std::move(obj));
      if (!consume(',')) return std::nullopt;
    }
  }

  std::optional<JsonValue> parseArray() {
    ++pos_;  // [
    JsonArray arr;
    skipWs();
    if (consume(']')) return JsonValue::makeArray(std::move(arr));
    while (true) {
      skipWs();
      auto val = parseValue();
      if (!val) return std::nullopt;
      arr.push_back(std::move(*val));
      skipWs();
      if (consume(']')) return JsonValue::makeArray(std::move(arr));
      if (!consume(',')) return std::nullopt;
    }
  }

  void appendUtf8(std::string& out, unsigned code) {
    if (code < 0x80) {
      out.push_back(static_cast<char>(code));
    } else if (code < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (code >> 6)));
      out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xE0 | (code >> 12)));
      out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    }
  }

  bool parseHex4(unsigned& out) {
    if (pos_ + 4 > s_.size()) return false;
    unsigned v = 0;
    for (int i = 0; i < 4; ++i) {
      char c = s_[pos_ + i];
      v <<= 4;
      if (c >= '0' && c <= '9')
        v |= static_cast<unsigned>(c - '0');
      else if (c >= 'a' && c <= 'f')
        v |= static_cast<unsigned>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F')
        v |= static_cast<unsigned>(c - 'A' + 10);
      else
        return false;
    }
    pos_ += 4;
    out = v;
    return true;
  }

  std::optional<std::string> parseString() {
    ++pos_;  // "
    std::string out;
    while (pos_ < s_.size()) {
      char c = s_[pos_++];
      if (c == '"') return out;
      if (c == '\\') {
        if (pos_ >= s_.size()) return std::nullopt;
        char e = s_[pos_++];
        switch (e) {
          case '"': out.push_back('"'); break;
          case '\\': out.push_back('\\'); break;
          case '/': out.push_back('/'); break;
          case 'b': out.push_back('\b'); break;
          case 'f': out.push_back('\f'); break;
          case 'n': out.push_back('\n'); break;
          case 'r': out.push_back('\r'); break;
          case 't': out.push_back('\t'); break;
          case 'u': {
            unsigned hi = 0;
            if (!parseHex4(hi)) return std::nullopt;
            if (hi >= 0xD800 && hi <= 0xDBFF) {
              // Par substituto: espera \uDC00..\uDFFF em seguida.
              if (pos_ + 6 > s_.size() || s_[pos_] != '\\' || s_[pos_ + 1] != 'u')
                return std::nullopt;
              pos_ += 2;
              unsigned lo = 0;
              if (!parseHex4(lo)) return std::nullopt;
              if (lo < 0xDC00 || lo > 0xDFFF) return std::nullopt;
              unsigned cp = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
              out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
              out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
              out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
              out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            } else if (hi >= 0xDC00 && hi <= 0xDFFF) {
              return std::nullopt;  // substituto baixo isolado
            } else {
              appendUtf8(out, hi);
            }
            break;
          }
          default: return std::nullopt;
        }
      } else {
        // Byte de controle cru é inválido em string JSON.
        if (static_cast<unsigned char>(c) < 0x20) return std::nullopt;
        out.push_back(c);
      }
    }
    return std::nullopt;  // string não terminada
  }

  std::optional<JsonValue> parseNumber() {
    size_t start = pos_;
    if (pos_ < s_.size() && (s_[pos_] == '-' || s_[pos_] == '+')) {
      if (s_[pos_] == '+') return std::nullopt;  // JSON não aceita +
      ++pos_;
    }
    bool digits = false;
    if (pos_ < s_.size() && s_[pos_] == '0') {
      // JSON não admite zero à esquerda ("01" é inválido, igual ao Mac).
      ++pos_;
      digits = true;
      if (pos_ < s_.size() && s_[pos_] >= '0' && s_[pos_] <= '9')
        return std::nullopt;
    } else {
      while (pos_ < s_.size() && s_[pos_] >= '0' && s_[pos_] <= '9') {
        ++pos_;
        digits = true;
      }
    }
    if (pos_ < s_.size() && s_[pos_] == '.') {
      ++pos_;
      bool frac = false;
      while (pos_ < s_.size() && s_[pos_] >= '0' && s_[pos_] <= '9') {
        ++pos_;
        frac = true;
      }
      if (!frac) return std::nullopt;
    }
    if (pos_ < s_.size() && (s_[pos_] == 'e' || s_[pos_] == 'E')) {
      ++pos_;
      if (pos_ < s_.size() && (s_[pos_] == '-' || s_[pos_] == '+')) ++pos_;
      bool exp = false;
      while (pos_ < s_.size() && s_[pos_] >= '0' && s_[pos_] <= '9') {
        ++pos_;
        exp = true;
      }
      if (!exp) return std::nullopt;
    }
    if (!digits || pos_ == start) return std::nullopt;
    double n = std::strtod(s_.c_str() + start, nullptr);
    if (!std::isfinite(n)) return std::nullopt;
    return JsonValue::makeNumber(n);
  }
};

bool getBool(const JsonValue& o, const char* key, bool fallback) {
  const JsonValue* v = o.find(key);
  if (!v || v->type != JsonValue::Type::Bool) return fallback;
  return v->boolean;
}
double getNum(const JsonValue& o, const char* key, double fallback,
              bool* present = nullptr) {
  const JsonValue* v = o.find(key);
  if (!v || v->type != JsonValue::Type::Number) {
    if (present) *present = false;
    return fallback;
  }
  if (present) *present = true;
  return v->number;
}
std::string getStr(const JsonValue& o, const char* key) {
  const JsonValue* v = o.find(key);
  if (!v || v->type != JsonValue::Type::String) return {};
  return v->str;
}

bool fillWindow(const JsonValue& v, RedlineWindow& w) {
  if (v.type != JsonValue::Type::Object) return false;
  w.kind = getStr(v, "kind");
  w.label = getStr(v, "label");
  bool has = false;
  w.usedRatio = getNum(v, "usedRatio", 0.0, &has);
  w.hasUsed = has;
  w.resetsAt = getNum(v, "resetsAt", 0.0, &w.hasResetsAt);
  return true;
}

bool fillEntry(const JsonValue& v, RedlineEntry& e) {
  if (v.type != JsonValue::Type::Object) return false;
  e.id = getStr(v, "id");
  e.adapterId = getStr(v, "adapterId");
  if (e.id.empty() || e.adapterId.empty()) return false;
  e.accountId = getStr(v, "accountId");
  e.label = getStr(v, "label");
  e.emailMasked = getStr(v, "emailMasked");
  e.active = getBool(v, "active", false);
  e.installed = getBool(v, "installed", false);
  e.onCooldown = getBool(v, "onCooldown", false);
  e.cooldownUntil = getNum(v, "cooldownUntil", 0.0, &e.hasCooldownUntil);
  e.updatedAt = getNum(v, "updatedAt", 0.0);
  e.eligible = getBool(v, "eligible", false);
  e.excludedReason = getStr(v, "excludedReason");
  e.headroom = getNum(v, "headroom", 0.0, &e.hasHeadroom);
  if (const JsonValue* w = v.find("windows");
      w && w->type == JsonValue::Type::Array && w->array) {
    for (const JsonValue& item : *w->array) {
      RedlineWindow win;
      if (fillWindow(item, win)) e.windows.push_back(std::move(win));
    }
  }
  if (const JsonValue* d = v.find("decisiveWindow");
      d && d->type == JsonValue::Type::Object) {
    e.hasDecisive = true;
    e.decisive.label = getStr(*d, "label");
    e.decisive.effectiveUsedRatio = getNum(*d, "effectiveUsedRatio", 0.0);
    e.decisive.resetsAt = getNum(*d, "resetsAt", 0.0, &e.decisive.hasResetsAt);
  }
  return true;
}

}  // namespace

const JsonValue* JsonValue::find(const std::string& key) const {
  if (type != Type::Object || !object) return &kMissing;
  for (const auto& kv : *object) {
    if (kv.first == key) return &kv.second;
  }
  return &kMissing;
}

std::optional<JsonValue> parseJson(const std::string& text) {
  Parser p(text);
  return p.run();
}

std::optional<RedlineSnapshot> snapshotFromJson(const JsonValue& root) {
  if (root.type != JsonValue::Type::Object) return std::nullopt;
  const JsonValue* fv = root.find("formatVersion");
  if (!fv || fv->type != JsonValue::Type::Number) return std::nullopt;
  RedlineSnapshot snap;
  snap.formatVersion = static_cast<long long>(fv->number);
  snap.generatedBy = getStr(root, "generatedBy");
  snap.updatedAt = getNum(root, "updatedAt", 0.0);
  snap.worstUsedRatio = getNum(root, "worstUsedRatio", 0.0, &snap.hasWorst);
  const JsonValue* entries = root.find("entries");
  if (!entries || entries->type != JsonValue::Type::Array || !entries->array)
    return std::nullopt;
  for (const JsonValue& item : *entries->array) {
    RedlineEntry e;
    if (fillEntry(item, e)) snap.entries.push_back(std::move(e));
  }
  if (snap.entries.empty()) return std::nullopt;
  if (const JsonValue* ranking = root.find("ranking");
      ranking && ranking->type == JsonValue::Type::Object && ranking->object) {
    for (const auto& kv : *ranking->object) {
      if (!kv.second.array) continue;
      std::vector<RedlineRankingRow> rows;
      for (const JsonValue& item : *kv.second.array) {
        if (item.type != JsonValue::Type::Object) continue;
        RedlineRankingRow r;
        r.entryId = getStr(item, "entryId");
        r.adapterId = getStr(item, "adapterId");
        r.label = getStr(item, "label");
        r.emailMasked = getStr(item, "emailMasked");
        r.headroom = getNum(item, "headroom", 0.0);
        if (const JsonValue* d = item.find("decisiveWindow");
            d && d->type == JsonValue::Type::Object) {
          r.hasDecisive = true;
          r.decisive.label = getStr(*d, "label");
          r.decisive.effectiveUsedRatio = getNum(*d, "effectiveUsedRatio", 0.0);
          r.decisive.resetsAt = getNum(*d, "resetsAt", 0.0, &r.decisive.hasResetsAt);
        }
        r.minutesToReset = getNum(item, "minutesToReset", 0.0, &r.hasMinutesToReset);
        rows.push_back(std::move(r));
      }
      snap.ranking[kv.first] = std::move(rows);
    }
  }
  if (const JsonValue* ids = root.find("statusBarEntryIds");
      ids && ids->type == JsonValue::Type::Array && ids->array) {
    snap.hasStatusBarIds = true;
    for (const JsonValue& item : *ids->array) {
      if (item.type == JsonValue::Type::String)
        snap.statusBarEntryIds.push_back(item.str);
    }
  }
  return snap;
}

std::optional<RedlineSnapshot> loadSnapshotFile(const std::string& pathUtf8) {
#ifdef _WIN32
  int wlen = MultiByteToWideChar(CP_UTF8, 0, pathUtf8.c_str(), -1, nullptr, 0);
  if (wlen <= 0) return std::nullopt;
  std::wstring wpath(static_cast<size_t>(wlen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, pathUtf8.c_str(), -1, wpath.data(), wlen);
  std::ifstream in(wpath, std::ios::binary);
#else
  std::ifstream in(pathUtf8, std::ios::binary);
#endif
  if (!in) return std::nullopt;
  std::ostringstream ss;
  ss << in.rdbuf();
  auto v = parseJson(ss.str());
  if (!v) return std::nullopt;
  return snapshotFromJson(*v);
}

std::string refreshRequestBody(std::int64_t nowMs) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), "{\"source\":\"tray\",\"at\":%lld}\n",
                static_cast<long long>(nowMs));
  return std::string(buf);
}

bool writeRefreshRequest(const std::string& dirUtf8, std::int64_t nowMs) {
#ifdef _WIN32
  std::string tmp = dirUtf8;
  for (char& c : tmp) {
    if (c == '/') c = '\\';
  }
  int wlen = MultiByteToWideChar(CP_UTF8, 0, tmp.c_str(), -1, nullptr, 0);
  if (wlen <= 0) return false;
  std::wstring wdir(static_cast<size_t>(wlen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, tmp.c_str(), -1, wdir.data(), wlen);
  // CreateDirectoryW com path já terminado em NUL duplo: ignorar erro
  // (diretório pode já existir).
  CreateDirectoryW(wdir.c_str(), nullptr);
  std::wstring wfile = wdir;
  if (!wfile.empty() && wfile.back() != L'\\') wfile.push_back(L'\\');
  wfile += L"redline-refresh.request";
  std::string body = refreshRequestBody(nowMs);
  HANDLE h = CreateFileW(wfile.c_str(), GENERIC_WRITE, 0, nullptr,
                         CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  BOOL ok = WriteFile(h, body.data(), static_cast<DWORD>(body.size()),
                      &written, nullptr);
  CloseHandle(h);
  return ok && written == body.size();
#else
  std::string path = dirUtf8 + "/redline-refresh.request";
  std::FILE* f = nullptr;
#if defined(_MSC_VER)
  if (fopen_s(&f, path.c_str(), "wb") != 0) return false;
#else
  f = std::fopen(path.c_str(), "wb");
  if (!f) return false;
#endif
  std::string body = refreshRequestBody(nowMs);
  size_t n = std::fwrite(body.data(), 1, body.size(), f);
  std::fclose(f);
  return n == body.size();
#endif
}

std::string redlineHomeDirUtf8() {
#ifdef _WIN32
  wchar_t* env = nullptr;
  size_t len = 0;
  if (_wdupenv_s(&env, &len, L"NEXUS_REDLINE_HOME") == 0 && env != nullptr) {
    std::wstring over(env);
    free(env);
    if (!over.empty()) {
      int n = WideCharToMultiByte(CP_UTF8, 0, over.c_str(), -1, nullptr, 0,
                                  nullptr, nullptr);
      if (n > 0) {
        std::string out(static_cast<size_t>(n) - 1, '\0');
        WideCharToMultiByte(CP_UTF8, 0, over.c_str(), -1, out.data(), n,
                            nullptr, nullptr);
        return out;
      }
    }
  }
  wchar_t* profile = nullptr;
  size_t profileLen = 0;
  if (_wdupenv_s(&profile, &profileLen, L"USERPROFILE") == 0 &&
      profile != nullptr) {
    std::wstring home(profile);
    free(profile);
    if (!home.empty()) {
      int n = WideCharToMultiByte(CP_UTF8, 0, home.c_str(), -1, nullptr, 0,
                                  nullptr, nullptr);
      if (n > 0) {
        std::string out(static_cast<size_t>(n) - 1, '\0');
        WideCharToMultiByte(CP_UTF8, 0, home.c_str(), -1, out.data(), n,
                            nullptr, nullptr);
        return out + "/.nexus";
      }
    }
  }
  return "./.nexus";
#else
  const char* over = std::getenv("NEXUS_REDLINE_HOME");
  if (over && *over) return std::string(over);
  const char* home = std::getenv("HOME");
  if (!home || !*home) home = ".";
  return std::string(home) + "/.nexus";
#endif
}

// ── Formatação ───────────────────────────────────────────────────────────────

std::string glyphFor(const std::string& adapterId) {
  if (adapterId == "claude") return "\xE2\x9C\xB3";               // ✳
  if (adapterId == "codex" || adapterId == "openai") return "\xE2\x9D\x8B";  // ❋
  if (adapterId == "grok") return "\xF0\x9D\x95\x8F";             // 𝕏
  if (adapterId == "kimi") return "K";
  if (adapterId == "gemini") return "\xE2\x9C\xA6";               // ✦
  if (adapterId == "glm") return "G";
  if (adapterId == "antigravity" || adapterId == "agy") return "\xE2\x96\xB2";  // ▲
  if (adapterId == "cursor") return "\xE2\x96\xA3";               // ▣
  if (adapterId == "opencode") return "\xE2\x8C\x98";             // ⌘
  if (adapterId == "aider") return "A";
  if (adapterId == "longcat") return "L";
  if (adapterId == "minimax-code") return "M";
  return "\xE2\x97\x8F";  // ●
}

std::string providerName(const std::string& adapterId) {
  if (adapterId == "claude") return "Claude";
  if (adapterId == "codex") return "Codex";
  if (adapterId == "glm") return "GLM";
  if (adapterId == "opencode") return "OpenCode";
  if (adapterId == "agy" || adapterId == "antigravity") return "Antigravity";
  if (adapterId == "minimax-code") return "MiniMax Code";
  if (adapterId.empty()) return adapterId;
  std::string out = adapterId;
  out[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(out[0])));
  return out;
}

Urgency urgencyFor(const bool hasUsed, double used) {
  if (!hasUsed) return Urgency::Unknown;
  if (used >= 0.85) return Urgency::Danger;
  if (used >= 0.60) return Urgency::Warn;
  return Urgency::Ok;
}

std::string countdownText(bool has, double resetsAtMs, std::int64_t nowMs) {
  if (!has) return "\xE2\x80\x93";  // –
  double remaining = resetsAtMs - static_cast<double>(nowMs);
  if (remaining <= 0) return "agora";
  double minutes = remaining / 60000.0;
  if (minutes < 60) {
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%dm",
                  static_cast<int>(std::ceil(minutes)));
    return buf;
  }
  double hours = minutes / 60.0;
  if (hours < 48) {
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%dh",
                  static_cast<int>(std::ceil(hours)));
    return buf;
  }
  char buf[16];
  std::snprintf(buf, sizeof(buf), "%dd",
                static_cast<int>(std::ceil(hours / 24.0)));
  return buf;
}

std::string pctText(bool has, double used) {
  if (!has) return "?";
  char buf[16];
  std::snprintf(buf, sizeof(buf), "%d%%",
                static_cast<int>(std::lround(used * 100.0)));
  return buf;
}

std::string ageLabel(double updatedAtMs, std::int64_t nowMs) {
  double ageMs = static_cast<double>(nowMs) - updatedAtMs;
  long long seconds = static_cast<long long>(ageMs / 1000.0);
  if (seconds < 90) return "agora mesmo";
  long long minutes = seconds / 60;
  if (minutes < 60) return "h\xC3\xA1 " + std::to_string(minutes) + " min";
  long long hours = minutes / 60;
  if (hours < 36) return "h\xC3\xA1 " + std::to_string(hours) + "h";
  return "h\xC3\xA1 " + std::to_string(hours / 24) + "d";
}

std::string barsText(bool has, double used) {
  if (!has) return "\xC2\xB7\xC2\xB7\xC2\xB7\xC2\xB7\xC2\xB7";  // ·····
  double clamped = used < 0 ? 0 : (used > 1 ? 1 : used);
  int filled = static_cast<int>(std::lround(clamped * 5.0));
  std::string out;
  for (int i = 0; i < filled; ++i) out += "\xE2\x96\xAE";  // ▮
  for (int i = filled; i < 5; ++i) out += "\xE2\x96\x91";  // ░
  return out;
}

std::vector<const RedlineEntry*> entriesForBar(const RedlineSnapshot& snap) {
  std::vector<const RedlineEntry*> out;
  if (snap.hasStatusBarIds && !snap.statusBarEntryIds.empty()) {
    for (const RedlineEntry& e : snap.entries) {
      for (const std::string& id : snap.statusBarEntryIds) {
        if (e.id == id) {
          out.push_back(&e);
          break;
        }
      }
    }
    return out;
  }
  for (const RedlineEntry& e : snap.entries) {
    if (out.size() >= 6) break;
    for (const RedlineWindow& w : e.windows) {
      if (w.hasUsed) {
        out.push_back(&e);
        break;
      }
    }
  }
  return out;
}

namespace {
bool isBarKind(const std::string& kind) {
  return kind == "hours" || kind == "session" || kind == "weekly" ||
         kind == "monthly";
}
}  // namespace

WorstWindow worstBarWindow(const RedlineSnapshot& snap) {
  WorstWindow worst;
  double top = -1.0;
  for (const RedlineEntry* e : entriesForBar(snap)) {
    for (const RedlineWindow& w : e->windows) {
      if (!isBarKind(w.kind) || !w.hasUsed) continue;
      if (w.usedRatio > top) {
        top = w.usedRatio;
        worst.entry = e;
        worst.window = &w;
      }
    }
  }
  return worst;
}

std::string accountState(const RedlineEntry& entry, std::int64_t nowMs) {
  std::string out;
  auto append = [&](const std::string& s) {
    if (!out.empty()) out += " \xC2\xB7 ";  // " · "
    out += s;
  };
  if (entry.onCooldown) {
    append("Em espera \xC2\xB7 " +
           countdownText(entry.hasCooldownUntil, entry.cooldownUntil, nowMs));
  }
  if (entry.excludedReason == "no-credential") {
    append("Sem credencial");
  } else if (entry.excludedReason == "needs-relogin") {
    append("Sess\xC3\xA3o expirada");
  } else if (entry.excludedReason == "cooldown" && !entry.onCooldown) {
    append("Em espera");
  }
  return out;
}

std::optional<BestPick> bestRankingPick(const RedlineSnapshot& snap) {
  std::optional<BestPick> best;
  for (const auto& kv : snap.ranking) {
    for (const RedlineRankingRow& row : kv.second) {
      if (!best || row.headroom > best->row.headroom) {
        best = BestPick{kv.first, row};
      }
    }
  }
  return best;
}

bool isStale(const RedlineSnapshot& snap, std::int64_t nowMs) {
  double ageMs = static_cast<double>(nowMs) - snap.updatedAt;
  return ageMs / 1000.0 > 10 * 60;
}

std::u16string clipUtf16(const std::u16string& text, size_t maxChars) {
  if (text.size() <= maxChars) return text;
  size_t cut = maxChars;
  // Recua sobre substituto baixo órfão; alto órfão no fim também sai.
  while (cut > 0) {
    char16_t c = text[cut - 1];
    if (c >= 0xDC00 && c <= 0xDFFF) {
      --cut;  // baixo sem par
    } else if (c >= 0xD800 && c <= 0xDBFF) {
      --cut;  // alto cujo par ficou fora
      break;
    } else {
      break;
    }
  }
  return text.substr(0, cut);
}

// ── Self-test ────────────────────────────────────────────────────────────────

namespace {
int gFailures = 0;
std::string gReport;

void check(bool cond, const char* name) {
  gReport += cond ? "[ok] " : "[FALHOU] ";
  gReport += name;
  gReport += "\n";
  if (!cond) ++gFailures;
}

const char* kFixture = R"JSON({
  "formatVersion": 1,
  "generatedBy": "nexus",
  "updatedAt": 1780000000000,
  "worstUsedRatio": 0.9,
  "entries": [
    {
      "id": "claude:acc1", "adapterId": "claude", "accountId": "acc1",
      "label": "Claude Pessoal", "emailMasked": "gu****@g**.com",
      "active": true, "installed": true, "onCooldown": false,
      "windows": [
        {"kind": "session", "label": "Sessão", "usedRatio": 0.9,
         "resetsAt": 1780003600000},
        {"kind": "weekly", "label": "Semanal", "usedRatio": 0.4}
      ],
      "updatedAt": 1780000000000, "eligible": true, "headroom": 0.1,
      "decisiveWindow": {"label": "Sessão", "effectiveUsedRatio": 0.9}
    },
    {
      "id": "codex:acc2", "adapterId": "codex", "accountId": "acc2",
      "label": "Codex", "active": false, "installed": true,
      "onCooldown": true, "cooldownUntil": 1780001200000,
      "windows": [
        {"kind": "weekly", "label": "Semanal"}
      ],
      "updatedAt": 1779999000000, "eligible": false,
      "excludedReason": "cooldown", "headroom": 0.0
    }
  ],
  "ranking": {
    "claude": [
      {"entryId": "claude:acc1", "adapterId": "claude",
       "label": "Claude Pessoal", "headroom": 0.1,
       "decisiveWindow": {"label": "Sessão", "effectiveUsedRatio": 0.9}}
    ]
  },
  "statusBarEntryIds": ["claude:acc1"]
})JSON";
}  // namespace

bool runSelfTests(std::string& reportOut) {
  gFailures = 0;
  gReport.clear();

  // Parser: tipos, escapes, erros.
  {
    auto v = parseJson("{\"a\":[1,true,null,\"x\\u00e9\\ud83d\\ude00\"]}trailing");
    check(!v, "lixo apos valor rejeitado");
    v = parseJson("{\"a\":[1,true,null,\"x\\u00e9\\ud83d\\ude00\"]}");
    check(!!v, "parse basico");
    check(v && v->find("a")->type == JsonValue::Type::Array, "array achado");
    const JsonValue* s = v ? v->find("a")->array->at(3).type == JsonValue::Type::String
                                 ? &v->find("a")->array->at(3)
                                 : nullptr
                           : nullptr;
    check(s && s->str == "x\xC3\xA9\xF0\x9F\x98\x80", "escape \\u + par substituto");
    check(!parseJson("{\"a\":}"), "objeto invalido rejeitado");
    check(!parseJson("[01]"), "numero invalido rejeitado");
    check(!parseJson("{\"a\":12"), "truncado rejeitado");
    check(!parseJson("\"\\ud800\""), "substituto isolado rejeitado");
    check(!parseJson("{\"a\":1e}"), "expoente invalido rejeitado");
  }

  // Snapshot do fixture.
  std::optional<RedlineSnapshot> snap;
  {
    auto v = parseJson(kFixture);
    check(!!v, "fixture parseia");
    snap = v ? snapshotFromJson(*v) : std::nullopt;
    check(!!snap, "fixture vira snapshot");
  }
  if (snap) {
    const std::int64_t now = 1780000000000LL + 30 * 1000;
    check(snap->entries.size() == 2, "duas contas");
    check(snap->entries[0].windows.size() == 2, "duas janelas");
    check(!snap->entries[1].windows[0].hasUsed, "sem leitura = null");
    check(snap->entries[1].decisive.label.empty() && !snap->entries[1].hasDecisive,
          "sem decisiva");
    check(snap->entries[0].hasDecisive, "com decisiva");

    WorstWindow w = worstBarWindow(*snap);
    check(w.entry && w.entry->id == "claude:acc1", "pior janela e conta");
    check(w.window && w.window->kind == "session", "pior kind session");

    auto best = bestRankingPick(*snap);
    check(best && best->row.headroom == 0.1, "recomendacao maior folga");

    check(countdownText(true, 1780003600000.0, 1780000000000LL) == "1h",
          "countdown 60min vira 1h");
    check(countdownText(true, 1779999999000.0, 1780000000000LL) == "agora",
          "countdown passado vira agora");
    check(countdownText(false, 0, now) == "\xE2\x80\x93", "countdown null vira –");
    check(pctText(true, 0.9) == "90%", "pct 90%");
    check(pctText(false, 0) == "?", "pct null vira ?");
    check(ageLabel(1780000000000.0, 1780000000000LL + 60 * 1000) == "agora mesmo",
          "idade 1min");
    check(ageLabel(1780000000000.0, 1780000000000LL + 5 * 60 * 1000) == "h\xC3\xA1 5 min",
          "idade 5min");
    // 0.9*5 = 4.5 → 5 (metade arredonda para cima, igual ao Swift).
    check(barsText(true, 0.9) ==
              "\xE2\x96\xAE\xE2\x96\xAE\xE2\x96\xAE\xE2\x96\xAE\xE2\x96\xAE",
          "barras 0.9 = 5 cheias");
    check(barsText(true, 0.62) ==
              "\xE2\x96\xAE\xE2\x96\xAE\xE2\x96\xAE\xE2\x96\x91\xE2\x96\x91",
          "barras 0.62 = 3 cheias");
    check(glyphFor("grok") == "\xF0\x9D\x95\x8F", "glifo grok");
    check(glyphFor("desconhecido") == "\xE2\x97\x8F", "glifo padrao");
    check(providerName("agy") == "Antigravity", "nome agy");
    check(providerName("kimi") == "Kimi", "nome kimi capitalizado");
    check(glyphFor("minimax-code") == "M", "glifo minimax-code");
    check(providerName("minimax-code") == "MiniMax Code", "nome minimax-code");
    check(accountState(snap->entries[0], now).empty(), "conta saudavel sem estado");
    std::string st = accountState(snap->entries[1], 1780000000000LL);
    check(st.find("Em espera") != std::string::npos, "cooldown vira Em espera");
    check(!isStale(*snap, now), "snapshot fresco");
    check(isStale(*snap, 1780000000000LL + 11 * 60 * 1000), "snapshot velho = stale");

    // Faixa sem statusBarEntryIds: cai para as 6 primeiras com leitura.
    RedlineSnapshot noIds = *snap;
    noIds.hasStatusBarIds = false;
    noIds.statusBarEntryIds.clear();
    auto bar = entriesForBar(noIds);
    check(bar.size() == 1 && bar[0]->id == "claude:acc1", "fallback da faixa");

    check(refreshRequestBody(1780000000000LL) ==
              "{\"source\":\"tray\",\"at\":1780000000000}\n",
          "corpo do refresh");

    // clipUtf16: nunca parte par substituto no teto do tooltip.
    {
      std::u16string emoji = u"A\U0001F600B";  // A + 😀 + B
      check(clipUtf16(emoji, 10) == emoji, "clip sem corte");
      std::u16string cut = clipUtf16(emoji, 2);  // cortaria no meio do par
      check(cut == u"A", "clip recua o par partido");
      check(clipUtf16(u"abcdef", 4) == u"abcd", "clip ascii");
      check(clipUtf16(u"abc", 0).empty(), "clip zero");
    }
  }

  // Estrutura inválida não vira snapshot.
  {
    auto v = parseJson("{\"formatVersion\":1,\"entries\":[]}");
    check(v && !snapshotFromJson(*v), "sem contas rejeitado");
    v = parseJson("[]");
    check(v && !snapshotFromJson(*v), "raiz array rejeitada");
    v = parseJson("{\"entries\":[]}");
    check(v && !snapshotFromJson(*v), "sem formatVersion rejeitado");
  }

  gReport += gFailures == 0 ? "Redline Windows checks passed\n"
                            : "REDLINE WINDOWS CHECKS FAILED\n";
  reportOut = gReport;
  return gFailures == 0;
}

}  // namespace redline

