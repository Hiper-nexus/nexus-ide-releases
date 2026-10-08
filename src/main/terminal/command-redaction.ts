/**
 * Redator de segredos do Nexus (linha de comando e texto livre). A
 * implementação é pura e vive em `shared/secret-redaction.ts` para o pacote de
 * continuidade do failover redigir no próprio builder, no Main e no renderer
 * (F-999). Código de produção importa `shared/secret-redaction` direto: este
 * repasse com `export *` gerava no bundle do Main uma chamada
 * `init_secret_redaction()` sem definição no chunk e o app empacotado não
 * abria (gate da candidata 0.76.210). Fica só para os testes antigos.
 */
export * from '../../shared/secret-redaction';
