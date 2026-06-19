# Pin npm packages by running ./bin/importmap

pin "application"
pin "@hotwired/turbo-rails", to: "turbo.min.js"
pin "@hotwired/stimulus", to: "stimulus.min.js"
pin "@hotwired/stimulus-loading", to: "stimulus-loading.js"
pin_all_from "app/javascript/controllers", under: "controllers"

# Chess rules engine (move legality, FEN/PGN). ESM build vendored under vendor/javascript.
pin "chess.js", to: "chess.js"
# UCI wrapper around the Stockfish worker.
pin "engine", to: "engine.js"
# Note: Stockfish runs as a Web Worker from /stockfish/stockfish.js (public/), not via
# importmap — workers can't be ESM imports and the asm.js build needs no cross-origin
# isolation headers.
