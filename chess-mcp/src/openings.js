// A compact opening book keyed by the move sequence (SAN, space-joined). Enough for a coach to
// name common openings the demo will actually reach. Longest-prefix match wins.
//
// Not exhaustive — a real deployment could swap in a full ECO database. Kept inline so the
// MCP server has zero data-file dependencies.

const OPENINGS = [
  ["e4", "King's Pawn Opening"],
  ["e4 e5", "Open Game"],
  ["e4 e5 Nf3", "King's Knight Opening"],
  ["e4 e5 Nf3 Nc6", "King's Knight, Normal Variation"],
  ["e4 e5 Nf3 Nc6 Bb5", "Ruy López (Spanish Opening)"],
  ["e4 e5 Nf3 Nc6 Bc4", "Italian Game"],
  ["e4 e5 Nf3 Nc6 Bc4 Bc5", "Italian Game, Giuoco Piano"],
  ["e4 e5 Nf3 Nc6 d4", "Scotch Game"],
  ["e4 e5 Nf3 Nf6", "Petrov's Defense"],
  ["e4 c5", "Sicilian Defense"],
  ["e4 c5 Nf3 d6", "Sicilian, Najdorf-ish setup"],
  ["e4 c6", "Caro-Kann Defense"],
  ["e4 e6", "French Defense"],
  ["e4 d5", "Scandinavian Defense"],
  ["e4 g6", "Modern Defense"],
  ["d4", "Queen's Pawn Opening"],
  ["d4 d5", "Closed Game"],
  ["d4 d5 c4", "Queen's Gambit"],
  ["d4 d5 c4 e6", "Queen's Gambit Declined"],
  ["d4 d5 c4 dxc4", "Queen's Gambit Accepted"],
  ["d4 Nf6", "Indian Defense"],
  ["d4 Nf6 c4 g6", "King's Indian / Grünfeld complex"],
  ["d4 Nf6 c4 e6", "Nimzo/Queen's Indian complex"],
  ["c4", "English Opening"],
  ["Nf3", "Réti Opening"],
];

// Given an array of SAN moves, return the name of the longest matching opening prefix.
export function nameOpening(sanMoves) {
  const seq = sanMoves.join(" ");
  let best = null;
  for (const [prefix, name] of OPENINGS) {
    if ((seq === prefix || seq.startsWith(prefix + " ")) &&
        (!best || prefix.length > best.prefix.length)) {
      best = { prefix, name };
    }
  }
  return best ? best.name : "an irregular / unnamed opening";
}
