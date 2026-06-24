# Drives the headless Agentforce Agent API for the MCP coach (Chess_Coach_MCP). This is the
# server side of the "auto-comment on my moves" feature and the toggle's second path: the browser
# posts each completed turn (player move + computer reply + difficulty), and we compose a grounded
# prompt and relay the agent's reply back.
#
# Why server-side composition: the agent grounds on a FEN via its MCP tools, so we hand it the
# live position in plain text every turn — no MIAW prechat pipeline, no builder changes. We also
# keep the Salesforce session id + sequence number out of the browser (cached server-side), so the
# client only ever deals with "post this turn, render that reply".
#
# Session lifecycle is lazy: the first message for a (user, game) starts an Agent API session and
# caches {session_id, sequence}; subsequent messages reuse it; game-over / sign-out ends it.
class AgentChatsController < ApplicationController
  before_action :authenticate_user!
  before_action :set_game

  SESSION_TTL = 2.hours # cache the SF session handle for the length of a long game

  # POST /games/:game_id/agent_chat — explicitly start (or reuse) a session. Optional: the panel
  # can call this on open to warm the session, but `message` also creates lazily, so this is just
  # a convenience handle.
  def create
    handle = session_handle # creates if absent
    render json: { sessionId: handle[:session_id], sequence: handle[:sequence] }
  rescue ServiceError => e
    render json: { error: e.message }, status: :bad_gateway
  end

  # POST /games/:game_id/agent_chat/message — send one turn. Body is either a move payload (the
  # auto-comment after a completed turn) or a free-text follow-up question.
  #   { playerMove: {san, fenBefore}, computerMove: {san, fenAfter}, difficulty: {label, elo} }
  #   { text: "why was that a blunder?" }
  def message
    handle = session_handle
    seq = handle[:sequence] + 1
    text = compose_message

    response = client.send_message(session_id: handle[:session_id], seq: seq, text: text)
    reply = AgentApiClient.reply_text(response)

    # Persist the advanced sequence only after a successful send.
    store_handle(handle.merge(sequence: seq))

    render json: { reply: reply, sequence: seq }
  rescue AgentApiClient::TimeoutError
    render json: { error: "The coach took too long to respond. Try again." }, status: :gateway_timeout
  rescue ServiceError, AgentApiClient::Error, AgentforceToken::Error => e
    render json: { error: e.message }, status: :bad_gateway
  end

  # DELETE /games/:game_id/agent_chat — end the session (game over / sign-out / panel unload).
  def destroy
    handle = read_handle
    if handle
      client.end_session(session_id: handle[:session_id])
      Rails.cache.delete(cache_key)
    end
    head :no_content
  rescue ServiceError => e
    render json: { error: e.message }, status: :bad_gateway
  end

  private

  # Raised when the headless deployment isn't configured yet (no ECA / agent id). Surfaces a clean
  # 502 to the panel instead of a 500 trace while the user hasn't created the ECA.
  ServiceError = Class.new(StandardError)

  def set_game
    @game = current_user.games.find(params[:game_id])
  end

  def deployment
    @deployment ||= AgentDeployment.agent_api ||
      raise(ServiceError, "Headless Agent API deployment is not configured")
  end

  def client
    @client ||= AgentApiClient.new(deployment: deployment)
  end

  # Cache key scopes a session to one user + game so two tabs/games don't cross streams.
  def cache_key
    "agent_session:#{current_user.id}:#{@game.id}"
  end

  def read_handle
    Rails.cache.read(cache_key)
  end

  def store_handle(handle)
    Rails.cache.write(cache_key, handle, expires_in: SESSION_TTL)
  end

  # Get the cached session handle, starting a new Agent API session if there isn't one.
  def session_handle
    read_handle || start_new_session
  end

  def start_new_session
    external_key = SecureRandom.uuid
    response = client.start_session(external_key: external_key)
    session_id = response["sessionId"] || response.dig("session", "sessionId")
    raise ServiceError, "Agent API did not return a sessionId" if session_id.blank?

    handle = { session_id: session_id, sequence: 0, external_key: external_key }
    store_handle(handle)
    handle
  end

  # Build the turn's text. A free-text follow-up is sent as-is; otherwise we narrate the completed
  # turn so the coach can ground on the live FEN via its MCP tools.
  def compose_message
    free_text = params[:text].to_s.strip
    return free_text if free_text.present?

    player = params.dig(:playerMove, :san)
    fen_before = params.dig(:playerMove, :fenBefore)
    computer = params.dig(:computerMove, :san)
    fen_after = params.dig(:computerMove, :fenAfter)
    elo = params.dig(:difficulty, :elo)
    label = params.dig(:difficulty, :label)

    parts = []
    parts << "I'm #{player_name} playing White"
    parts << opponent_clause(elo, label)
    parts << "."
    parts << " I just played #{player} (FEN before my move: #{fen_before})." if player.present?
    parts << " The engine replied #{computer} (FEN now: #{fen_after})." if computer.present?
    parts << " Coach me on my move — name any opening or tactic and flag mistakes, grounding your"
    parts << " analysis in the current FEN."
    parts.join
  end

  def opponent_clause(elo, label)
    if elo.present?
      " against a ~#{elo}-rated engine#{label.present? ? " (#{label})" : ""}"
    else
      " against the computer"
    end
  end

  # We don't carry a verified first name server-side (the MIAW path looks it up from the Contact;
  # headless bypasses the user). Derive a friendly display name from the email local part.
  def player_name
    local = current_user.email.to_s.split("@").first.to_s
    name = local.split(/[._]/).first
    name.present? ? name.capitalize : "the player"
  end
end
