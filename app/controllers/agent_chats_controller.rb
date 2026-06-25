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

  # The upsell shown when an unsubscribed user tries to use the coach. Coaching is a paid feature;
  # everyone can play + open the coach, but only subscribed Contacts get analysis. Mirrors the
  # wording the MIAW agent uses when its in-agent gate trips, so both coaches say the same thing.
  SUBSCRIPTION_REQUIRED_MSG =
    "Coaching is a premium feature — you'll need an active subscription to unlock live analysis " \
    "and move-by-move coaching. You can keep playing the computer for free in the meantime!".freeze

  # Latency lever (proven 2026-06-25): an Agent API turn's wall-clock is dominated by OUTPUT-TOKEN
  # generation, not tool calls — constraining the reply length ~halves turn time (terse ~5.5s vs a
  # multi-paragraph ~17s). We can't shorten the agent's built-in verbosity without a builder edit,
  # but every turn's prompt is composed HERE, so we bake the concision directive into the prompt
  # itself. Appended to BOTH the move-coaching turn and free-text follow-ups. Kept tight: lead with
  # the point, cap the length, plain prose (the panel renders plain text, so no markdown overhead).
  BREVITY = " Reply in at most 2–3 short sentences. Lead with the key verdict or idea, then one " \
            "concrete tip. Be direct and conversational; no headings, lists, or markdown.".freeze

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
    # Deterministic subscription gate (the hard gate for the headless path). The Agent API session
    # is bypassUser, so the agent can't see who the user is — we check HERE, where we know
    # current_user, and short-circuit before spending an agent turn. Reads the same Salesforce
    # Contact.Is_Subscribed__c the MIAW coach gates on (single source of truth). Fails closed.
    unless Subscription.active?(current_user.email)
      return render json: { reply: SUBSCRIPTION_REQUIRED_MSG, gated: true }
    end

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
  #
  # IMPORTANT (2026-06-25): lead with the CURRENT FEN and ask the coach to analyze the current
  # position — do NOT frame it as "explain the move I played" with a before/after FEN pair. The
  # two-FEN "explain_move" framing was unreliable: the agent would mis-pair the SAN move with a FEN,
  # its MCP tool would error, and it would bail with "I lost track of your position — resend the
  # FEN." A single current-FEN "analyze this position" turn grounds reliably (verified live: the
  # one-FEN shape works, the two-FEN/explain shape fails). The last move is mentioned only as
  # context; the analysis is always anchored to the current FEN.
  def compose_message
    free_text = params[:text].to_s.strip
    return "#{free_text}#{BREVITY}" if free_text.present?

    player = params.dig(:playerMove, :san)
    computer = params.dig(:computerMove, :san)
    # The current position is the board AFTER the computer's reply; if the computer hasn't moved
    # (e.g. the player just delivered mate/stalemate), fall back to the board after the player move.
    current_fen = params.dig(:computerMove, :fenAfter).presence || params.dig(:playerMove, :fenBefore)
    elo = params.dig(:difficulty, :elo)
    label = params.dig(:difficulty, :label)

    parts = []
    parts << "I'm #{player_name} playing White"
    parts << opponent_clause(elo, label)
    parts << ". The current position is FEN: #{current_fen}."
    # Last move as plain context (not an explain-the-move directive — that framing breaks grounding).
    if player.present? && computer.present?
      parts << " (I just played #{player} and the engine replied #{computer}.)"
    elsif player.present?
      parts << " (I just played #{player}.)"
    end
    parts << " Analyze the current position for me — use your engine on this exact FEN, name any"
    parts << " opening or tactic, and flag mistakes. Don't ask me to resend anything; analyze the"
    parts << " FEN as given."
    parts << BREVITY
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
