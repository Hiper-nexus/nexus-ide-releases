import { describe, expect, it } from "vitest";

import {
  calibratedProvidersFrom,
  classifyProviderProbe,
  PROVIDER_PROBE_MARKER,
  PROVIDER_PROBE_UNCALIBRATED,
  probeProviderWithSpec,
  isGatewayConfigured,
  providerProbeSpec,
  runProviderPreflight,
  summarizeProviderPreflight,
} from "./release-provider-preflight.mjs";

// REGRESSAO: numa noite de release, sete missoes reais degradaram no MESMO
// commit e MESMOS artefatos (8/8 -> 7/7 -> 6/5 handoffs) porque provedores
// pararam de responder. O recibo da ultima nomeou a causa: worker sem
// atividade e sem heartbeat por 10 minutos. Cada descoberta custou ~40 min.
describe("classifyProviderProbe", () => {
  it("aprova saida limpa", () => {
    expect(
      classifyProviderProbe({ installed: true, status: 0, timedOut: false }),
    ).toBe("healthy");
  });

  it("trata CLI ausente como absent, nao como falha", () => {
    // O roster ja lida com CLI nao instalada; reprovar aqui bloquearia o gate
    // por um provedor que a missao nem usaria.
    expect(classifyProviderProbe({ installed: false })).toBe("absent");
    expect(classifyProviderProbe(null)).toBe("absent");
  });

  it("timeout e o sinal de esgotamento: unresponsive", () => {
    expect(
      classifyProviderProbe({ installed: true, timedOut: true, status: null }),
    ).toBe("unresponsive");
  });

  it("separa auth de indisponibilidade porque o remedio difere", () => {
    expect(
      classifyProviderProbe({
        installed: true,
        status: 1,
        stderr: "API Error: 401 Unauthorized",
      }),
    ).toBe("unauthenticated");
    expect(
      classifyProviderProbe({
        installed: true,
        status: 1,
        stderr: "Please run /login to continue",
      }),
    ).toBe("unauthenticated");
    expect(
      classifyProviderProbe({ installed: true, status: 7, stderr: "boom" }),
    ).toBe("unresponsive");
  });

  it("status nao numerico nao passa por acidente", () => {
    expect(
      classifyProviderProbe({ installed: true, status: undefined }),
    ).toBe("unresponsive");
  });
});

describe("summarizeProviderPreflight", () => {
  it("deixa comecar quando todos respondem ou estao ausentes", () => {
    const verdict = summarizeProviderPreflight([
      { cli: "codex", verdict: "healthy" },
      { cli: "kimi", verdict: "absent" },
    ]);
    expect(verdict.ok).toBe(true);
    expect(verdict.blocking).toHaveLength(0);
  });

  it("bloqueia nomeando o provedor e o custo evitado", () => {
    const verdict = summarizeProviderPreflight([
      { cli: "codex", verdict: "healthy" },
      { cli: "grok", verdict: "unresponsive" },
      { cli: "glm", verdict: "unauthenticated" },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.blocking.map((entry) => entry.cli)).toEqual(["grok", "glm"]);
    expect(verdict.summary).toContain("grok (unresponsive)");
    expect(verdict.summary).toContain("glm (unauthenticated)");
    // O operador precisa saber por que isso vale um preflight.
    expect(verdict.summary).toContain("40 min");
  });
});

describe("runProviderPreflight", () => {
  it("classifica cada cli e consolida o veredito", async () => {
    const probes = {
      codex: { installed: true, status: 0, timedOut: false },
      grok: { installed: true, status: null, timedOut: true },
      kimi: { installed: false },
    };
    const verdict = await runProviderPreflight(
      ["codex", "grok", "kimi"],
      async (cli) => probes[cli],
    );

    expect(verdict.results.map((entry) => entry.verdict)).toEqual([
      "healthy",
      "unresponsive",
      "absent",
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toContain("grok");
  });

  it("sonda que explode conta como nao-responsiva, nunca como saudavel", async () => {
    // O gate nao pode comecar apostando que o provedor esta bem so porque a
    // propria sonda quebrou.
    const verdict = await runProviderPreflight(["agy"], async () => {
      throw new Error("spawn falhou");
    });

    expect(verdict.results[0].verdict).toBe("unresponsive");
    expect(verdict.ok).toBe(false);
    expect(verdict.results[0].probe.stderr).toContain("spawn falhou");
  });
});

// A tabela de sondas so entra em vigor porque cada comando foi executado
// contra o provedor real e teve a saida observada. Sonda nao validada
// bloquearia release legitima -- pior que o problema que resolve.
describe("sondas calibradas", () => {
  it("so bloqueia CLIs com comando validado; o resto nunca reprova", () => {
    const calibradas = calibratedProvidersFrom([
      "codex",
      "claude",
      "grok",
      "agy",
      "kimi",
      "glm",
      "opencode",
    ]);
    expect(calibradas.sort()).toEqual(
      ["claude", "codex", "grok"].sort(),
    );
    for (const cli of PROVIDER_PROBE_UNCALIBRATED) {
      expect(providerProbeSpec(cli)).toBeNull();
    }
  });

  it("grok usa sonda de auth sem gastar turno de LLM", () => {
    expect(providerProbeSpec("grok").kind).toBe("auth");
    expect(providerProbeSpec("grok").args).toEqual(["models"]);
    // As demais custam um turno minimo -- ordens de grandeza menos que
    // descobrir o mesmo 40 minutos depois.
    expect(providerProbeSpec("codex").kind).toBe("turn");
  });

  it("CLI sem spec devolve absent em vez de comando adivinhado", () => {
    let chamou = false;
    const probe = probeProviderWithSpec("kimi", () => {
      chamou = true;
      return { status: 0 };
    });
    expect(chamou).toBe(false);
    expect(classifyProviderProbe(probe)).toBe("absent");
  });

  it("binario fora do PATH e absent, nao falha de provedor", () => {
    const probe = probeProviderWithSpec("codex", () => ({
      spawnFailed: true,
    }));
    expect(classifyProviderProbe(probe)).toBe("absent");
  });

  it("reconhece os modos de falha REAIS observados nesta maquina", () => {
    // claude: "Failed to authenticate: OAuth session expired and could not be
    // refreshed" -- foi o exhaustedAdapterIds:["claude"] das diretivas de
    // reroute que reprovaram participationIsExact a noite inteira.
    const claude = probeProviderWithSpec("claude", () => ({
      status: 1,
      stderr: "Failed to authenticate: OAuth session expired and could not be refreshed",
    }));
    expect(classifyProviderProbe(claude)).toBe("unauthenticated");


    // codex saudavel: turno real respondido.
    const codex = probeProviderWithSpec("codex", () => ({
      status: 0,
      stdout: `${PROVIDER_PROBE_MARKER}\n`,
    }));
    expect(classifyProviderProbe(codex)).toBe("healthy");
  });
});

// REGRESSAO: com o gateway de IA ligado (ex.: um roteador proprio do
// operador), a credencial de claude/codex passa a ser a CHAVE DO GATEWAY,
// injetada pelo Nexus no spawn. A sonda roda no shell do gate, que NAO tem
// essa injecao, entao ela reportaria "unauthenticated" para um provedor que a
// missao usaria sem problema — o mesmo falso negativo ja provado no opencode.
describe("preflight ciente do gateway", () => {
  it("sonda normalmente quando o gateway esta desligado", () => {
    expect(providerProbeSpec("claude", {})).not.toBeNull();
    expect(providerProbeSpec("codex", {})).not.toBeNull();
    expect(
      calibratedProvidersFrom(["codex", "claude", "grok"], {}).sort(),
    ).toEqual(["claude", "codex", "grok"]);
  });

  it("nao sonda as CLIs roteadas pelo gateway quando ele esta ligado", () => {
    const env = { NEXUS_AI_GATEWAY_BASE_URL: "https://gateway.example" };
    expect(providerProbeSpec("claude", env)).toBeNull();
    expect(providerProbeSpec("codex", env)).toBeNull();
    // grok nao e roteado pelo gateway: continua sondado de verdade.
    expect(providerProbeSpec("grok", env)).not.toBeNull();
    expect(calibratedProvidersFrom(["codex", "claude", "grok"], env)).toEqual([
      "grok",
    ]);
  });

  it("CLI roteada e tratada como absent, nunca como falha", () => {
    const env = { NEXUS_AI_GATEWAY_BASE_URL: "https://gateway.example" };
    let chamou = false;
    const probe = probeProviderWithSpec(
      "claude",
      () => {
        chamou = true;
        return { status: 1, stderr: "Failed to authenticate" };
      },
      env,
    );
    expect(chamou).toBe(false);
    expect(classifyProviderProbe(probe)).toBe("absent");
  });

  it("URL vazia ou so espaco nao liga o gateway", () => {
    expect(isGatewayConfigured({ NEXUS_AI_GATEWAY_BASE_URL: "" })).toBe(false);
    expect(isGatewayConfigured({ NEXUS_AI_GATEWAY_BASE_URL: "   " })).toBe(false);
    expect(isGatewayConfigured({})).toBe(false);
    expect(
      isGatewayConfigured({ NEXUS_AI_GATEWAY_BASE_URL: "https://x.example" }),
    ).toBe(true);
  });
});
