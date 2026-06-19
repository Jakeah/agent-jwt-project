class GamesController < ApplicationController
  before_action :authenticate_user!
  before_action :set_game, only: %i[show move finish]

  def index
    @games = current_user.games.order(created_at: :desc)
  end

  def show
  end

  def create
    @game = current_user.games.create!(fen: Game::STARTING_FEN, status: "active")
    redirect_to @game
  end

  # PATCH /games/:id/move — persist the board after a move (called by the chess Stimulus
  # controller via fetch). Stores the current FEN and running PGN.
  def move
    @game.update!(fen: params.require(:fen), pgn: params[:pgn])
    head :no_content
  end

  # PATCH /games/:id/finish — record terminal state (checkmate/stalemate/draw/resigned).
  def finish
    @game.update!(status: params.require(:status), result: params[:result])
    head :no_content
  end

  private

  def set_game
    @game = current_user.games.find(params[:id])
  end
end
