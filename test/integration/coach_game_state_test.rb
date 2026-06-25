require "test_helper"

# The verified MIAW coach pulls live game state from this back-channel endpoint (keyed by the
# verified Contact's email) because hidden prechat goes stale on a verified user's persistent
# conversation. These tests pin the trust boundary (bearer token, fail-closed) and the snapshot
# shape the Apex action depends on.
class CoachGameStateTest < ActionDispatch::IntegrationTest
  TOKEN = "test-coach-pull-token"

  setup do
    @user = User.create!(email: "Player@Example.com", password: "password123")
    @game = @user.games.create!(
      fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      pgn: "1. e4 c5",
      status: "active",
    )
  end

  # Swap COACH_PULL_TOKEN for the block, then restore (no Mocha in this project — plain ENV save).
  def with_env(key, value)
    had = ENV.key?(key)
    prev = ENV[key]
    value.nil? ? ENV.delete(key) : ENV[key] = value
    yield
  ensure
    had ? ENV[key] = prev : ENV.delete(key)
  end

  def with_token(&block) = with_env("COACH_PULL_TOKEN", TOKEN, &block)

  def auth_headers(token = TOKEN) = { "Authorization" => "Bearer #{token}" }

  test "returns the player's live game snapshot for a valid token + email" do
    with_token do
      get "/coach/game_state", params: { email: "player@example.com" }, headers: auth_headers
    end
    assert_response :success
    body = JSON.parse(response.body)
    assert_equal true, body["found"]
    assert_equal @game.id, body["gameId"]
    assert_equal "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", body["fen"]
    assert_equal "1. e4 c5", body["pgn"]
    assert_equal "c5", body["lastMove"]     # most recent SAN, parsed from the PGN
    assert_equal "White", body["turn"]      # FEN field 2 = "w"
    assert_equal 1, body["moveCount"]       # FEN field 6 = "2" → 1 full move completed
    assert_equal "active", body["status"]
  end

  test "email match is case-insensitive (verified email casing varies)" do
    with_token do
      get "/coach/game_state", params: { email: "PLAYER@EXAMPLE.COM" }, headers: auth_headers
    end
    assert_response :success
    assert_equal @game.id, JSON.parse(response.body)["gameId"]
  end

  test "returns found:false (not an error) when the player has no account" do
    with_token do
      get "/coach/game_state", params: { email: "nobody@example.com" }, headers: auth_headers
    end
    assert_response :success
    body = JSON.parse(response.body)
    assert_equal false, body["found"]
  end

  test "returns the most recently updated game when several exist" do
    newer = @user.games.create!(fen: Game::STARTING_FEN, pgn: "", status: "active")
    newer.update!(updated_at: 1.hour.from_now)
    with_token do
      get "/coach/game_state", params: { email: "player@example.com" }, headers: auth_headers
    end
    assert_equal newer.id, JSON.parse(response.body)["gameId"]
  end

  test "rejects a missing token (fails closed)" do
    with_token do
      get "/coach/game_state", params: { email: "player@example.com" }
    end
    assert_response :unauthorized
  end

  test "rejects a wrong token" do
    with_token do
      get "/coach/game_state", params: { email: "player@example.com" }, headers: auth_headers("nope")
    end
    assert_response :unauthorized
  end

  test "fails closed when COACH_PULL_TOKEN is unset in the environment" do
    with_env("COACH_PULL_TOKEN", nil) do
      get "/coach/game_state", params: { email: "player@example.com" }, headers: auth_headers
    end
    assert_response :unauthorized
  end
end
