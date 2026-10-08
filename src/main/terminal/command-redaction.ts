/**
 * Redator de segredos do Nexus (linha de comando e texto livre). A
 * implementação é pura e vive em `shared/secret-redaction.ts` para o pacote de
 * continuidade do failover redigir no próprio builder, no Main e no renderer
 * (F-999); este caminho continua valendo para os chamadores do Main.
 */
export * from '../../shared/secret-redaction';
