/** Hold-to-interact registry. The scene registers everything reachable and,
 * every frame, asks which item deserves the prompt: the nearest one whose
 * label applies to the current state. Pure — label() and onComplete() see the
 * same state object the game loop owns, so a null label is all it takes to
 * make an item inert (a full coffee machine, a rack already installed). */

export function createInteractables() {
  return { list: [] };
}

export function register(interactables, definition) {
  interactables.list.push({ ...definition });
  return definition;
}

/** The item the prompt belongs to, or null when nothing applies here. */
export function nearest(interactables, pos, state) {
  const list = Array.isArray(interactables) ? interactables : interactables.list;
  let best = null, bestDistance = Infinity;
  for (const item of list) {
    if (item.label(state) == null) continue;
    const distance = Math.hypot(pos.x - item.x, pos.z - item.z);
    if (distance <= item.radius && distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
}

/** Advances one hold by dt. Mutates the accumulator so the hot loop only
 * allocates the small result while a button is pressed.
 * ponytail: a single hold exists at a time in this game; if that ever
 * changes, return the progress as fields on the hold itself. */
export function holdStep(hold, dt) {
  hold.elapsed += dt;
  const progress = Math.min(1, hold.elapsed / hold.duration);
  return { progress, done: progress >= 1 };
}

/** Decide o segurar deste quadro. `hold` é o acumulador do loop: ele zera sempre
 * que o alvo ou a ação mudam, e também enquanto a ação está bloqueada ou o botão
 * está solto, então tempo segurado num alvo nunca vale para outro.
 * Devolve 'idle', 'blocked', 'progress' ou 'done'. */
export function advanceHold(hold, item, label, pressed, dt) {
  if (hold.item !== item || hold.label !== label) {
    hold.item = item;
    hold.label = label;
    hold.elapsed = 0;
  }
  if (!pressed || !item || !label) { hold.elapsed = 0; return 'idle'; }
  if (label.blocked) { hold.elapsed = 0; return 'blocked'; }
  hold.duration = label.duration;
  hold.elapsed += dt;
  if (hold.elapsed >= hold.duration) { hold.elapsed = 0; return 'done'; }
  return 'progress';
}
