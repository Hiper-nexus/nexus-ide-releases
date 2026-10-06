/**
 * `fs` SEM o tratamento de `.asar` do Electron.
 *
 * Dentro do Electron o `fs` do Node trata qualquer caminho terminado em `.asar` como um arquivo virtual: gravar
 * `resources/app.asar` de uma instalação NOVA (a atualização do Linux) falha com "Invalid package". O `original-fs`
 * é o mesmo módulo sem esse desvio. Use-o só onde o código mexe numa instalação do app em disco (extrair a
 * atualização, apagar a pasta antiga); o resto do app continua com o `fs` normal. Fora do Electron (testes) o
 * alias do vitest aponta para o `node:fs`.
 */
import originalFs from 'original-fs';

export const realFs: typeof import('node:fs') = originalFs as unknown as typeof import('node:fs');
export default realFs;
