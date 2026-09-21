// Nexus Redline (Windows) — modelo + parser + formatação.
//
// Espelho fiel do contrato de src/shared/redline-types.ts e da lógica de
// apresentação de native/menubar-redline/*.swift, sem nenhuma dependência
// além da STL: este arquivo não inclui <windows.h> de propósito, para que a
// suíte --self-test exercite a mesma lógica que a bandeja desenha.
//
// Doutrina (igual ao Mac): read-only sobre ~/.nexus/redline-last-good.json.
// Nunca lê credencial, nunca renova token, nunca fala com provider ou rede.
// Único efeito colateral: o arquivo-sinal redline-refresh.request.

#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace redline {

// ── JSON mínimo (subconjunto suficiente para o snapshot) ─────────────────────

struct JsonValue;
using JsonArray = std::vector<JsonValue>;
using JsonObject = std::vector<std::pair<std::string, JsonValue>>;

struct JsonValue {
  enum class Type { Null, Bool, Number, String, Array, Object };
  Type type = Type::Null;
  bool boolean = false;
  double number = 0.0;
  std::string str;
  std::shared_ptr<JsonArray> array;
  std::shared_ptr<JsonObject> object;

  static JsonValue makeNull() { return JsonValue(); }
  static JsonValue makeBool(bool b) {
    JsonValue v;
    v.type = Type::Bool;
    v.boolean = b;
    return v;
  }
  static JsonValue makeNumber(double n) {
    JsonValue v;
    v.type = Type::Number;
    v.number = n;
    return v;
  }
  static JsonValue makeString(std::string s) {
    JsonValue v;
    v.type = Type::String;
    v.str = std::move(s);
    return v;
  }
  static JsonValue makeArray(JsonArray a) {
    JsonValue v;
    v.type = Type::Array;
    v.array = std::make_shared<JsonArray>(std::move(a));
    return v;
  }
  static JsonValue makeObject(JsonObject o) {
    JsonValue v;
    v.type = Type::Object;
    v.object = std::make_shared<JsonObject>(std::move(o));
    return v;
  }

  const JsonValue* find(const std::string& key) const;
  bool isNull() const { return type == Type::Null; }
  std::string asString(const std::string& fallback = "") const {
    return type == Type::String ? str : fallback;
  }
  double asNumber(double fallback = 0.0) const {
    return type == Type::Number ? number : fallback;
  }
  bool asBool(bool fallback = false) const {
    return type == Type::Bool ? boolean : fallback;
  }
};

/// Parse estrito: rejeita lixo após o valor e valores truncados.
std::optional<JsonValue> parseJson(const std::string& text);

// ── Modelo (espelho de redline-types.ts) ─────────────────────────────────────

struct RedlineWindow {
  std::string kind;
  std::string label;
  bool hasUsed = false;
  double usedRatio = 0.0;
  bool hasResetsAt = false;
  double resetsAt = 0.0;  // epoch ms
};

struct RedlineDecisiveWindow {
  std::string label;
  double effectiveUsedRatio = 0.0;
  bool hasResetsAt = false;
  double resetsAt = 0.0;
};

struct RedlineEntry {
  std::string id;
  std::string adapterId;
  std::string accountId;
  std::string label;
  std::string emailMasked;
  bool active = false;
  bool installed = false;
  bool onCooldown = false;
  bool hasCooldownUntil = false;
  double cooldownUntil = 0.0;  // epoch ms
  std::vector<RedlineWindow> windows;
  double updatedAt = 0.0;
  bool eligible = false;
  std::string excludedReason;
  bool hasHeadroom = false;
  double headroom = 0.0;
  bool hasDecisive = false;
  RedlineDecisiveWindow decisive;
};

struct RedlineRankingRow {
  std::string entryId;
  std::string adapterId;
  std::string label;
  std::string emailMasked;
  double headroom = 0.0;
  bool hasDecisive = false;
  RedlineDecisiveWindow decisive;
  bool hasMinutesToReset = false;
  double minutesToReset = 0.0;
};

struct RedlineSnapshot {
  long long formatVersion = 0;
  std::string generatedBy;
  double updatedAt = 0.0;
  bool hasWorst = false;
  double worstUsedRatio = 0.0;
  std::vector<RedlineEntry> entries;
  std::map<std::string, std::vector<RedlineRankingRow>> ranking;
  bool hasStatusBarIds = false;
  std::vector<std::string> statusBarEntryIds;
};

/// Monta o snapshot a partir de JSON já parseado. Nullopt = arquivo sem
/// forma válida (o Mac faz o mesmo: decode falhou → sem dados).
std::optional<RedlineSnapshot> snapshotFromJson(const JsonValue& root);

/// Lê e valida o arquivo de snapshot. Nullopt quando ausente/ilegível.
std::optional<RedlineSnapshot> loadSnapshotFile(const std::string& pathUtf8);

/// Corpo do arquivo-sinal: {"source":"tray","at":<ms>}\n
std::string refreshRequestBody(std::int64_t nowMs);
bool writeRefreshRequest(const std::string& dirUtf8, std::int64_t nowMs);

// ── Caminhos ─────────────────────────────────────────────────────────────────

/// ~/.nexus (UTF-8). NEXUS_REDLINE_HOME sobrescreve o home (seam de teste).
std::string redlineHomeDirUtf8();
inline std::string snapshotPathForHome(const std::string& homeUtf8) {
  return homeUtf8 + "/redline-last-good.json";
}
inline std::string refreshPathForHome(const std::string& homeUtf8) {
  return homeUtf8 + "/redline-refresh.request";
}

// ── Formatação (espelho do Swift) ────────────────────────────────────────────

std::string glyphFor(const std::string& adapterId);
std::string providerName(const std::string& adapterId);

enum class Urgency { Unknown, Ok, Warn, Danger };
Urgency urgencyFor(const bool hasUsed, double used);

/// "38m", "12h", "6d", "agora"; null → "–".
std::string countdownText(bool has, double resetsAtMs, std::int64_t nowMs);
/// "42%" ou "?" quando desconhecido.
std::string pctText(bool has, double used);
/// "agora mesmo", "há 3 min", "há 2h", "há 4d".
std::string ageLabel(double updatedAtMs, std::int64_t nowMs);
/// 5 blocos "▮▮▮░░" (texto compacto p/ tooltip).
std::string barsText(bool has, double used);

/// Entradas que a faixa resume (statusBarEntryIds ou 6 primeiras c/ leitura).
std::vector<const RedlineEntry*> entriesForBar(const RedlineSnapshot& snap);

/// Corta texto UTF-16 no teto sem partir par substituto (tooltip da bandeja
/// tem 128 wchar_t; rótulo de conta pode conter emoji).
std::u16string clipUtf16(const std::u16string& text, size_t maxChars);

struct WorstWindow {
  const RedlineEntry* entry = nullptr;
  const RedlineWindow* window = nullptr;
};
/// Pior janela entre kinds hours/session/weekly/monthly das entradas da faixa.
WorstWindow worstBarWindow(const RedlineSnapshot& snap);

/// "Em espera · 12m", "Sem credencial", "Sessão expirada", "" quando saudável.
std::string accountState(const RedlineEntry& entry, std::int64_t nowMs);

struct BestPick {
  std::string adapterId;
  RedlineRankingRow row;
};
/// Linha de maior folga em todo o ranking (recomendação do header).
std::optional<BestPick> bestRankingPick(const RedlineSnapshot& snap);

/// true quando o snapshot envelheceu além de 10 min (igual ao Mac).
bool isStale(const RedlineSnapshot& snap, std::int64_t nowMs);

/// Relato da suíte --self-test. Retorna true quando tudo passou.
bool runSelfTests(std::string& reportOut);

}  // namespace redline
