import { Controller } from "@hotwired/stimulus";
import { LEVELS, getLevel, setLevel } from "game_state";

// The opponent strength picker on the game page. Renders the discrete LEVELS (defined once in
// game_state) into a <select>, reflects the persisted choice, and on change calls setLevel — which
// persists it, updates the shared snapshot the coaches read, and dispatches "chess:level-changed"
// so the live board re-arms the engine for the next computer move.
//
// No reload (unlike the coach-mode toggle): strength changes apply to the *next* move in-place, so
// the player can dial difficulty up or down mid-game without losing the position.
export default class extends Controller {
  static targets = ["select"];

  connect() {
    this.#populate();
  }

  // data-action: change->level-select#change
  change(event) {
    setLevel(event.target.value);
  }

  #populate() {
    if (!this.hasSelectTarget) return;
    const current = getLevel();
    this.selectTarget.innerHTML = LEVELS
      .map((l) => `<option value="${l.id}" ${l.id === current.id ? "selected" : ""}>${l.label} · ~${l.elo}</option>`)
      .join("");
  }
}
