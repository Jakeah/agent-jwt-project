class Game < ApplicationRecord
  # Standard chess starting position in Forsyth-Edwards Notation.
  STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".freeze

  belongs_to :user

  validates :status, inclusion: { in: %w[active checkmate stalemate draw resigned] }

  scope :active, -> { where(status: "active") }

  def finished?
    status != "active"
  end

  # This game's 1-based number within its OWNER's games (oldest = 1), for display. The raw `id` is
  # a global record number — it leaks how many games exist across all users and reads as arbitrary
  # ("Game #29" for your second game). Counting the owner's games up to and including this one gives
  # a clean per-user sequence. Ordered by `id` (monotonic with creation). Display only — routes and
  # path helpers still use the real `id`.
  def user_game_number
    user.games.where("id <= ?", id).count
  end
end
