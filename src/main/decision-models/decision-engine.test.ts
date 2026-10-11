import { describe, expect, it } from 'vitest';
import type { DecisionSettings } from '../../shared/decision-models';
import { planAutoDecision } from './decision-engine';
import { resolveDecisionRoute, type DecisionAvailability } from './decision-routing';
import type { DecisionQualityTable } from './decision-quality';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const auto: DecisionSettings = { mode: 'auto', clefModel: 'clef', cloudflareAccountId: ACCOUNT, visionEnabled: false };
const all: DecisionAvailability = { jev: true, clef: true, luna: true };
const question = { q: { type: 'noul' as const, instructions: 'Is it relevant?' } };
const text = (surface: string, extra: object = {}) => ({ state: 'payload', questions: question, surface, ...extra }) as never;
const image = [{ content_type: 'image/png' as const, base64: 'AAAA' }];
const audio = [{ content_type: 'audio/wav' as const, base64: 'AAAA' }];
const normal = { budgetLevel: 'normal' as const, quality: null };
const MEASURED: DecisionQualityTable = { version: 1, generatedAt: 1, source: 'evaluateDecisionCases', models: {},
  surfaces: { taskRouting: { jev: { accuracy: 0.85, cases: 10 }, 'clef-flash': { accuracy: 0.8, cases: 10 } } } };
const measured = { budgetLevel: 'normal' as const, quality: MEASURED };

describe('roteador v2 (F-1165): só no Automático', () => {
  it('modos explícitos não passam pelo v2', () => {
    for (const mode of ['jev', 'clef', 'luna', 'together'] as const) {
      expect(planAutoDecision(text('toolPick'), { ...auto, mode }, all, normal)).toBeNull();
    }
  });

  it('surfaces fixas no Jev continuam na rota v1, inclusive no limiar suave', () => {
    for (const surface of ['dispatchGuard', 'handoffReview', 'memoryDistill', 'computerTool', 'browserTool']) {
      for (const budgetLevel of ['normal', 'soft'] as const) {
        const plan = planAutoDecision(text(surface), auto, all, { budgetLevel, quality: null });
        expect(plan?.route).toEqual(resolveDecisionRoute(text(surface), auto, all));
        expect(plan?.route).toMatchObject({ provider: 'jev', policyVersion: 'jev-clef-luna-v1', reason: 'jev-pinned' });
        expect(plan?.members).toBeUndefined();
      }
    }
  });

  it('imagem no browserTool (fixo) mantém a variante v1', () => {
    const vision = { ...auto, visionEnabled: true };
    const plan = planAutoDecision(text('browserTool', { images: image }), vision, all, normal);
    expect(plan?.route).toEqual(resolveDecisionRoute(text('browserTool', { images: image }), vision, all));
  });

  it('modelo pedido pelo chamador continua v1', () => {
    const plan = planAutoDecision(text('toolPick', { model: 'clef' }), auto, all, normal);
    expect(plan?.route).toMatchObject({ provider: 'clef', model: 'clef', reason: 'explicit-model', policyVersion: 'jev-clef-luna-v1' });
  });
});

describe('roteador v2: variante Cloudflare pela necessidade', () => {
  it('texto de escolha barata vai ao clef-flash, não ao clef cheio', () => {
    const plan = planAutoDecision(text('toolPick'), auto, all, normal);
    expect(plan?.route).toMatchObject({ provider: 'clef', model: 'clef-flash', policyVersion: 'decision-engine-v2', evidence: 'prior' });
    expect(plan?.route.reason).toContain('toolPick');
    expect(plan?.route.reason).toContain('clef-flash');
  });

  it('texto comum fica no Jev quando ele tem chave', () => {
    expect(planAutoDecision(text('judgeTool'), auto, all, normal)?.route).toMatchObject({ provider: 'jev', policyVersion: 'decision-engine-v2' });
  });

  it('sem Jev, texto comum vai à variante Cloudflare mais vantajosa', () => {
    expect(planAutoDecision(text('judgeTool'), auto, { jev: false, clef: true }, normal)?.route.model).toBe('clef-flash');
  });

  it('imagem com consentimento Cloudflare vai ao clef-omni', () => {
    const plan = planAutoDecision(text('judgeTool', { images: image }), { ...auto, visionEnabled: true }, all, normal);
    expect(plan?.route).toMatchObject({ provider: 'clef', model: 'clef-omni' });
  });

  it('consentimento de imagem decide o destinatário', () => {
    const lunaOnly = { ...auto, visionEnabled: true, visionConsent: { version: 1 as const, recipients: ['luna' as const] } };
    expect(planAutoDecision(text('judgeTool', { images: image }), lunaOnly, all, normal)?.route.provider).toBe('luna');
    const nobody = { ...auto, visionEnabled: true, visionConsent: { version: 1 as const, recipients: [] } };
    expect(planAutoDecision(text('judgeTool', { images: image }), nobody, all, normal)).toBeNull();
    expect(planAutoDecision(text('judgeTool', { images: image }), auto, all, normal)).toBeNull();
    expect(planAutoDecision(text('judgeTool', { images: image }), { ...auto, visionEnabled: true }, { jev: true, clef: false, luna: false }, normal)).toBeNull();
  });

  it('áudio só sai ao clef-omni com a autorização de áudio', () => {
    const consented = { ...auto, clefModel: 'clef-omni' as const, audioConsent: { version: 1 as const, recipients: ['clef' as const] } };
    expect(planAutoDecision(text('wakeConfirm', { audio }), consented, all, normal)?.route).toMatchObject({ provider: 'clef', model: 'clef-omni' });
    // Sem autorização o clipe nunca sai: rota de texto (o Jev descarta o áudio).
    expect(planAutoDecision(text('wakeConfirm', { audio }), auto, all, normal)?.route.provider).toBe('jev');
    // Clipe obrigatório sem destino: política v1 intacta.
    const required = text('wakeConfirm', { audio, audioRequired: true });
    expect(planAutoDecision(required, auto, all, normal)?.route).toEqual(resolveDecisionRoute(required, auto, all));
  });
});

describe('roteador v2: orçamento e "usar várias"', () => {
  it('reversível, orçamento normal, 2+ provedores e qualidade medida: ensemble paralelo', () => {
    const plan = planAutoDecision(text('taskRouting'), auto, all, measured);
    expect(plan?.members?.map(member => member.provider)).toEqual(['jev', 'clef']);
    expect(plan?.members?.[1].model).toBe('clef-flash');
    expect(plan?.route.reason).toContain('usar várias');
    expect(plan!.estimatedUsd).toBeGreaterThan(planAutoDecision(text('judgeTool'), auto, all, normal)!.estimatedUsd);
  });

  it('só com prior nunca liga o ensemble (todo prior fica abaixo do teto)', () => {
    for (const surface of ['taskRouting', 'missionPick', 'catalogPick']) {
      const plan = planAutoDecision(text(surface), auto, all, normal);
      expect(plan?.members).toBeUndefined();
      expect(plan?.route.provider).toBe('jev');
    }
    // Um membro medido e o outro só com prior também não basta.
    const half: DecisionQualityTable = { ...MEASURED, surfaces: { taskRouting: { jev: { accuracy: 0.8, cases: 10 } } } };
    expect(planAutoDecision(text('taskRouting'), auto, all, { budgetLevel: 'normal', quality: half })?.members).toBeUndefined();
  });

  it('sem ensemble: surface normal, um só provedor, limiar suave ou modelo confiável', () => {
    expect(planAutoDecision(text('judgeTool'), auto, all, normal)?.members).toBeUndefined();
    expect(planAutoDecision(text('judgeTool'), auto, all, { budgetLevel: 'normal', quality: { ...MEASURED,
      surfaces: { judgeTool: MEASURED.surfaces.taskRouting } } })?.members).toBeUndefined();
    expect(planAutoDecision(text('taskRouting'), auto, { jev: true, clef: false, luna: false }, measured)?.members).toBeUndefined();
    expect(planAutoDecision(text('taskRouting'), auto, all, { budgetLevel: 'soft', quality: MEASURED })?.members).toBeUndefined();
    const trusted: DecisionQualityTable = { version: 1, generatedAt: 1, source: 'evaluateDecisionCases', models: {},
      surfaces: { taskRouting: { jev: { accuracy: 0.97, cases: 20 } } } };
    expect(planAutoDecision(text('taskRouting'), auto, all, { budgetLevel: 'normal', quality: trusted })?.members).toBeUndefined();
  });

  it('acima de 80%: só o mais barato elegível', () => {
    const soft = { budgetLevel: 'soft' as const, quality: null };
    expect(planAutoDecision(text('judgeTool'), auto, all, soft)?.route.model).toBe('clef-flash');
    expect(planAutoDecision(text('judgeTool'), auto, { jev: true, clef: false, luna: true }, soft)?.route.provider).toBe('jev');
    expect(planAutoDecision(text('judgeTool'), auto, all, soft)?.route.reason).toContain('80%');
  });

  it('avaliação local substitui o prior só com casos suficientes', () => {
    const table = (cases: number): DecisionQualityTable => ({ version: 1, generatedAt: 1, source: 'evaluateDecisionCases', models: {},
      surfaces: { judgeTool: { clef: { accuracy: 0.99, cases } } } });
    expect(planAutoDecision(text('judgeTool'), auto, all, { budgetLevel: 'normal', quality: table(10) })?.route)
      .toMatchObject({ model: 'clef', evidence: 'local-evaluation' });
    expect(planAutoDecision(text('judgeTool'), auto, all, { budgetLevel: 'normal', quality: table(2) })?.route)
      .toMatchObject({ provider: 'jev', evidence: 'prior' });
  });

  it('latência medida acima do orçamento da surface tira o candidato', () => {
    const slow: DecisionQualityTable = { version: 1, generatedAt: 1, source: 'evaluateDecisionCases', models: {},
      surfaces: { judgeTool: { clef: { accuracy: 0.99, cases: 10, p50Ms: 9_000 } } } };
    expect(planAutoDecision(text('judgeTool'), auto, all, { budgetLevel: 'normal', quality: slow })?.route.provider).toBe('jev');
  });
});
