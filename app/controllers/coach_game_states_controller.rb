# Server-to-server read endpoint that hands the player's LIVE game state to the Agentforce coach.
#
# Why this exists: hidden prechat fields are consumed only at conversation CREATION, and a verified
# (User-Verification/AUTH) user has ONE persistent conversation that every later chat-open RESUMES —
# so setHiddenPrechatFields is a no-op after the first open and MessagingSession.Chess_*__c goes
# stale/null. (See docs/miaw-prechat-to-agent-guide.md — "the verified-user continuity trap".) The
# fix is PULL, not push: an Apex action the agent calls each turn hits this endpoint for the current
# board, so continuity is irrelevant and the coach is always current.
#
# Auth model: this is a back-channel callout from Salesforce (Apex via the ChessLiveGame Named
# Credential), NOT a browser request — there's no Devise session. We gate on a shared bearer token
# (COACH_PULL_TOKEN) compared in constant time. The player is identified by the verified Contact's
# email, which Salesforce resolved from the RS256 identity token — so Rails only ever returns a
# game to the same person the chat already verified.
class CoachGameStatesController < ApplicationController
  # No Devise session on a server-to-server callout; we authenticate with a bearer token instead.
  skip_before_action :verify_authenticity_token, raise: false
  before_action :authenticate_service!

  # GET /coach/game_state?email=<verified player email>
  # Returns the player's most recent game as the coach-facing snapshot, or a clear "no game" shape.
  def show
    email = params[:email].to_s.strip.downcase
    return render(json: { found: false, reason: "no email supplied" }) if email.blank?

    user = User.find_by("LOWER(email) = ?", email)
    return render(json: { found: false, reason: "no player for #{email}" }) if user.nil?

    game = user.games.order(updated_at: :desc).first
    return render(json: { found: false, reason: "player has no games" }) if game.nil?

    render json: game_snapshot(game)
  end

  private

  # Flatten a Game into the same vocabulary the coach already knows from the prechat fields, so the
  # agent reasons identically whether state arrived via prechat (anonymous) or this pull (verified).
  # turn + move count are read straight off the FEN — it's self-describing (field 2 = side to move,
  # field 6 = full-move number), so no chess library is needed server-side.
  def game_snapshot(game)
    fields = game.fen.to_s.split
    side = fields[1] # "w" | "b"
    fullmove = fields[5].to_i # 1-based; increments after Black moves
    {
      found: true,
      gameId: game.id,
      fen: game.fen,
      pgn: game.pgn.to_s,
      turn: side == "b" ? "Black" : "White",
      # Full moves COMPLETED so far: before White's move N, (N-1) are done; before Black's, N-1 too
      # (White's Nth is played but the pair isn't complete). Matches game_state.js's moveCount.
      moveCount: [fullmove - 1, 0].max,
      status: game.status,
      updatedAt: game.updated_at.utc.iso8601,
    }
  end

  # Constant-time bearer check against COACH_PULL_TOKEN (Heroku config var / .env). A missing token
  # in the environment fails CLOSED — we never serve game state unauthenticated.
  def authenticate_service!
    expected = ENV["COACH_PULL_TOKEN"].to_s
    presented = request.authorization.to_s.sub(/\ABearer\s+/i, "")
    ok = expected.present? && presented.present? &&
         ActiveSupport::SecurityUtils.secure_compare(presented, expected)
    head :unauthorized unless ok
  end
end
