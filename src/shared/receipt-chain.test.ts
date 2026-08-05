import { describe, expect, it } from "vitest";
import {
  GENESIS_PREV_HASH_HEX,
  computeChainHash,
  handoffReceiptChainEntry,
  toStoragePrecision,
  verifyChain,
  type ChainedReceiptEntry,
  type HandoffReceiptChainMaterial,
  type ReceiptChainEntry,
} from "./receipt-chain";

const BASE_ISSUED_AT = 1_700_000_000_000;

function baseEntry(
  overrides: Partial<ReceiptChainEntry> = {},
): ReceiptChainEntry {
  return {
    missionId: "mission-chain-a",
    seq: 1,
    issuedAt: BASE_ISSUED_AT,
    receiptId: "receipt-1",
    toolName: "nexus_handoff_submit",
    authoritySha256: "a".repeat(64),
    workerIncarnationId: "incarnation-1",
    worktreeHeadSha: "b".repeat(40),
    detail: { handoffId: "handoff-1", source: "http-mcp" },
    ...overrides,
  };
}

/** Builds a well-formed chain exactly like the single writer does. */
function buildChain(count: number): ChainedReceiptEntry[] {
  const out: ChainedReceiptEntry[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= count; seq += 1) {
    const entry = baseEntry({
      seq,
      receiptId: `receipt-${seq}`,
      issuedAt: BASE_ISSUED_AT + seq * 1_000,
      detail: { handoffId: `handoff-${seq}`, source: "http-mcp" },
    });
    const chainHash = computeChainHash(entry, prev);
    out.push({ ...entry, chainHash, prevReceiptHash: prev });
    prev = chainHash;
  }
  return out;
}

describe("parallel disjoint-story receipts (P0-3 fan-out)", () => {
  it("verifies a mission chain whose links carry distinct per-story worktreeHeadSha", () => {
    // Each disjoint story merges from its own worktree, so consecutive links
    // carry different worktreeHeadSha values. The chain binds them by seq +
    // prevHash, never by a shared HEAD, so distinct per-story HEADs coexist.
    const heads = ["a".repeat(40), "c".repeat(40), "e".repeat(40)];
    const out: ChainedReceiptEntry[] = [];
    let prev: string | null = null;
    heads.forEach((head, index) => {
      const seq = index + 1;
      const entry = baseEntry({
        seq,
        receiptId: `receipt-story-${seq}`,
        issuedAt: BASE_ISSUED_AT + seq * 1_000,
        worktreeHeadSha: head,
        detail: { handoffId: `story-${seq}`, source: "pty-stream" },
      });
      const chainHash = computeChainHash(entry, prev);
      out.push({ ...entry, chainHash, prevReceiptHash: prev });
      prev = chainHash;
    });

    expect(new Set(out.map((e) => e.worktreeHeadSha)).size).toBe(3);
    expect(verifyChain(out, { requireGenesis: true })).toEqual({
      status: "valid",
      length: 3,
    });
  });
});

describe("computeChainHash", () => {
  it("é determinístico e produz 64 hex minúsculos", () => {
    const entry = baseEntry();
    const first = computeChainHash(entry, null);
    expect(first).toBe(computeChainHash(entry, null));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("genesis: prev null hasheia os 32 bytes zero (sentinela idêntica ao hex zerado)", () => {
    const entry = baseEntry();
    expect(computeChainHash(entry, null)).toBe(
      computeChainHash(entry, GENESIS_PREV_HASH_HEX),
    );
    expect(GENESIS_PREV_HASH_HEX).toBe("0".repeat(64));
  });

  it("armadilha (a): timestamp com subsegundos re-verifica após round-trip de storage", () => {
    // O escritor pode receber um issuedAt fracionário (ms com casas decimais);
    // SQLite guarda INTEGER. O hash cobre o valor truncado, então o preimage
    // gravado e o preimage relido da linha são idênticos.
    const fractional = BASE_ISSUED_AT + 123.456789;
    const written = baseEntry({ issuedAt: fractional });
    const readBack = baseEntry({ issuedAt: Math.trunc(fractional) });
    expect(computeChainHash(written, null)).toBe(
      computeChainHash(readBack, null),
    );
  });

  it("armadilha (a): toStoragePrecision trunca e é idempotente", () => {
    expect(toStoragePrecision(BASE_ISSUED_AT + 0.999)).toBe(BASE_ISSUED_AT);
    expect(toStoragePrecision(toStoragePrecision(BASE_ISSUED_AT + 0.5))).toBe(
      BASE_ISSUED_AT,
    );
    expect(toStoragePrecision(BASE_ISSUED_AT)).toBe(BASE_ISSUED_AT);
  });

  it("armadilha (b): detail com chaves fora de ordem produz o mesmo hash", () => {
    const a = baseEntry({
      detail: { z: 1, a: { y: 2, b: 3 }, m: [1, 2, 3] },
    });
    const b = baseEntry({
      detail: { a: { b: 3, y: 2 }, m: [1, 2, 3], z: 1 },
    });
    expect(computeChainHash(a, null)).toBe(computeChainHash(b, null));
  });

  it("armadilha (b): ordem de array continua significativa no detail", () => {
    const a = baseEntry({ detail: { m: [1, 2] } });
    const b = baseEntry({ detail: { m: [2, 1] } });
    expect(computeChainHash(a, null)).not.toBe(computeChainHash(b, null));
  });

  it("armadilha (c): campo presente-vazio difere de campo ausente", () => {
    const absent = baseEntry({ workerIncarnationId: undefined });
    const empty = baseEntry({ workerIncarnationId: "" });
    expect(computeChainHash(absent, null)).not.toBe(
      computeChainHash(empty, null),
    );

    const absentHead = baseEntry({ worktreeHeadSha: undefined });
    const emptyHead = baseEntry({ worktreeHeadSha: "" });
    expect(computeChainHash(absentHead, null)).not.toBe(
      computeChainHash(emptyHead, null),
    );
  });

  it("missionId participa da identidade: replay entre missões não colide", () => {
    const a = baseEntry();
    const b = baseEntry({ missionId: "mission-chain-b" });
    expect(computeChainHash(a, null)).not.toBe(computeChainHash(b, null));
  });

  it("é sensível a cada campo do preimage", () => {
    const base = baseEntry();
    const h0 = computeChainHash(base, null);
    const variants: ReceiptChainEntry[] = [
      baseEntry({ seq: 2 }),
      baseEntry({ issuedAt: BASE_ISSUED_AT + 1 }),
      baseEntry({ receiptId: "receipt-x" }),
      baseEntry({ toolName: "nexus_handoff_ack" }),
      baseEntry({ authoritySha256: "f".repeat(64) }),
      baseEntry({ workerIncarnationId: "incarnation-2" }),
      baseEntry({ worktreeHeadSha: "c".repeat(40) }),
      baseEntry({ detail: { handoffId: "handoff-2", source: "http-mcp" } }),
    ];
    for (const variant of variants) {
      expect(computeChainHash(variant, null)).not.toBe(h0);
    }
    expect(computeChainHash(base, "e".repeat(64))).not.toBe(h0);
  });

  it("armadilha (d): seq entra como u64 big-endian — vetor dourado congela o preimage", () => {
    // Golden vector: qualquer mudança no schema do preimage (ordem de campos,
    // endianness do seq, length-prefix, presence-tag, JSON canônico) quebra
    // este teste de propósito — mudar o preimage invalida cadeias existentes.
    const entry: ReceiptChainEntry = {
      missionId: "mission-golden",
      seq: 258,
      issuedAt: 1_700_000_000_123,
      receiptId: "receipt-golden",
      toolName: "nexus_handoff_submit",
      authoritySha256: "a".repeat(64),
      workerIncarnationId: "incarnation-golden",
      detail: { b: 1, a: "x" },
    };
    // Valor conferido por reconstrução independente do preimage documentado
    // no cabeçalho do módulo (não copiado da própria implementação).
    expect(computeChainHash(entry, null)).toBe(
      "06545519f27713edf883257d42223fa00ce092ab231c1c7f6bc3f737e18f5dd7",
    );
  });

  it("rejeita entradas estruturalmente inválidas em vez de hashear lixo", () => {
    expect(() => computeChainHash(baseEntry({ seq: 0 }), null)).toThrow();
    expect(() => computeChainHash(baseEntry({ seq: 1.5 }), null)).toThrow();
    expect(() =>
      computeChainHash(baseEntry({ issuedAt: Number.NaN }), null),
    ).toThrow();
    expect(() =>
      computeChainHash(baseEntry({ issuedAt: -1 }), null),
    ).toThrow();
    expect(() => computeChainHash(baseEntry({ missionId: "" }), null)).toThrow();
    expect(() => computeChainHash(baseEntry(), "zz".repeat(32))).toThrow();
    expect(() => computeChainHash(baseEntry(), "ab")).toThrow();
    // Falha de serialização é erro duro, nunca hasheada como vazio.
    expect(() =>
      computeChainHash(
        baseEntry({ detail: { bad: Number.POSITIVE_INFINITY } }),
        null,
      ),
    ).toThrow();
  });
});

describe("verifyChain", () => {
  it("cadeia válida verifica de ponta a ponta", () => {
    expect(verifyChain(buildChain(4))).toEqual({
      status: "valid",
      length: 4,
    });
    expect(verifyChain(buildChain(1))).toEqual({
      status: "valid",
      length: 1,
    });
  });

  it("cadeia vazia não é verificável", () => {
    expect(verifyChain([])).toEqual({ status: "empty" });
  });

  it("adulteração de um campo quebra a partir daquele elo", () => {
    const chain = buildChain(4);
    const tampered = chain.map((entry, index) =>
      index === 1
        ? { ...entry, detail: { handoffId: "forged", source: "http-mcp" } }
        : entry,
    );
    expect(verifyChain(tampered)).toEqual({
      status: "hash-mismatch",
      seq: 2,
    });

    const tamperedAuthority = chain.map((entry, index) =>
      index === 2 ? { ...entry, authoritySha256: "f".repeat(64) } : entry,
    );
    expect(verifyChain(tamperedAuthority)).toEqual({
      status: "hash-mismatch",
      seq: 3,
    });
  });

  it("reordenação dos elos quebra a cadeia", () => {
    const chain = buildChain(4);
    const reordered = [chain[0], chain[2], chain[1], chain[3]];
    expect(verifyChain(reordered)).toEqual({
      status: "chain-violation",
      seq: 3,
    });
  });

  it("não aceita salto de sequência mesmo quando o prev aponta para o elo anterior", () => {
    const chain = buildChain(3);
    const missing = [chain[0], chain[2]];
    expect(verifyChain(missing)).toEqual({
      status: "chain-violation",
      seq: 3,
    });
  });

  it("pode exigir genesis ao verificar a cadeia completa da missão", () => {
    const chain = buildChain(3);
    expect(verifyChain(chain.slice(1), { requireGenesis: true })).toEqual({
      status: "chain-violation",
      seq: 2,
    });
    expect(verifyChain(chain, { requireGenesis: true })).toEqual({
      status: "valid",
      length: 3,
    });
  });

  it("genesis correto: primeiro elo com prev não-nulo forjado não verifica", () => {
    const chain = buildChain(2);
    const forgedGenesis = [
      { ...chain[0], prevReceiptHash: "e".repeat(64) },
      chain[1],
    ];
    // O hash do elo 1 foi computado sobre a sentinela zero; declarar outro
    // prev muda o preimage recomputado e o elo deixa de bater.
    expect(verifyChain(forgedGenesis)).toEqual({
      status: "hash-mismatch",
      seq: 1,
    });
  });

  it("prev estruturalmente inválido é violação de cadeia, não exceção", () => {
    const chain = buildChain(2);
    const broken = [chain[0], { ...chain[1], prevReceiptHash: "not-hex" }];
    expect(verifyChain(broken)).toEqual({
      status: "chain-violation",
      seq: 2,
    });
  });

  it("elo transplantado de outra missão não verifica na cadeia local", () => {
    const chain = buildChain(3);
    const foreign = buildChain(3).map((entry) => ({
      ...entry,
      missionId: "mission-chain-b",
    }));
    const spliced = [chain[0], { ...foreign[1] }, chain[2]];
    expect(verifyChain(spliced)).toEqual({
      status: "mission-mismatch",
      seq: 2,
    });
  });

  it("verifica com timestamps truncados relidos do storage (armadilha (a) fim-a-fim)", () => {
    // Escrita: issuedAt fracionário chega ao hasher; leitura: INTEGER do SQLite.
    let prev: string | null = null;
    const stored: ChainedReceiptEntry[] = [];
    for (let seq = 1; seq <= 3; seq += 1) {
      const written = baseEntry({
        seq,
        receiptId: `receipt-${seq}`,
        issuedAt: BASE_ISSUED_AT + seq * 1_000 + 0.789,
      });
      const chainHash = computeChainHash(written, prev);
      stored.push({
        ...written,
        issuedAt: Math.trunc(written.issuedAt),
        chainHash,
        prevReceiptHash: prev,
      });
      prev = chainHash;
    }
    expect(verifyChain(stored)).toEqual({ status: "valid", length: 3 });
  });
});

describe("handoffReceiptChainEntry", () => {
  function material(
    overrides: Partial<HandoffReceiptChainMaterial> = {},
  ): HandoffReceiptChainMaterial {
    return {
      missionId: "mission-chain-a",
      seq: 1,
      issuedAt: BASE_ISSUED_AT,
      receiptId: "tool-call-1",
      handoffId: "handoff-1",
      toolCallId: "tool-call-1",
      toolName: "nexus_handoff_submit",
      source: "http-mcp",
      sessionId: "session-1",
      workerIncarnationId: "incarnation-1",
      authoritySha256: "a".repeat(64),
      worktreeHeadSha: "b".repeat(40),
      rawPayloadSha256: "c".repeat(64),
      logicalOperationKey: "d".repeat(64),
      ...overrides,
    };
  }

  it("mapeia colunas NULL para campos ausentes (presence-tag) de forma estável", () => {
    const absent = handoffReceiptChainEntry(
      material({ workerIncarnationId: null }),
    );
    expect("workerIncarnationId" in absent).toBe(false);
    const empty = handoffReceiptChainEntry(
      material({ workerIncarnationId: "" }),
    );
    expect(computeChainHash(absent, null)).not.toBe(
      computeChainHash(empty, null),
    );
  });

  it("dois materiais idênticos produzem o mesmo elo (independe de ordem de construção)", () => {
    const a = handoffReceiptChainEntry(material());
    const b = handoffReceiptChainEntry(material());
    expect(computeChainHash(a, null)).toBe(computeChainHash(b, null));
  });

  it("cada coluna do receipt participa do hash", () => {
    const h0 = computeChainHash(handoffReceiptChainEntry(material()), null);
    const variants: HandoffReceiptChainMaterial[] = [
      material({ handoffId: "handoff-2" }),
      material({ toolCallId: "tool-call-2" }),
      material({ source: "pty-stream" }),
      material({ sessionId: "session-2" }),
      material({ rawPayloadSha256: null }),
      material({ logicalOperationKey: null }),
      material({ worktreeHeadSha: null }),
    ];
    for (const variant of variants) {
      expect(
        computeChainHash(handoffReceiptChainEntry(variant), null),
      ).not.toBe(h0);
    }
  });
});
