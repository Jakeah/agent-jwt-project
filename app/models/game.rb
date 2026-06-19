class Game < ApplicationRecord
  # Standard chess starting position in Forsyth-Edwards Notation.
  STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".freeze

  belongs_to :user

  validates :status, inclusion: { in: %w[active checkmate stalemate draw resigned] }

  scope :active, -> { where(status: "active") }

  def finished?
    status != "active"
  end
end
