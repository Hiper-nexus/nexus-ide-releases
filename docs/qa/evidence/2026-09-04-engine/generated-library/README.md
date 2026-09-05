# Nexus mission proof

Temporary isolated workspace for an operator-authorized runtime verification.
Only files in this directory may be changed by the test missions.

## `sum.mjs`

Biblioteca mínima de soma. `sum(a, b)` aceita apenas números finitos e
lança `TypeError` para entradas inválidas (texto, `NaN`, `Infinity`, etc.).

```js
import { sum } from './sum.mjs';

sum(2, 3);      // 5
sum(-5, -3);    // -8
```

## Testes

Execute os testes com:

```sh
node --test sum.test.mjs
```
