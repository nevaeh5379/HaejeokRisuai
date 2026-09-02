export const saving = $state({ state: false });

let pendingSaves = 0;

export function beginSave(): () => void {
  pendingSaves += 1;
  saving.state = true;

  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    pendingSaves = Math.max(0, pendingSaves - 1);
    saving.state = pendingSaves > 0;
  };
}
