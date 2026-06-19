require "application_system_test_case"

class ChessGameTest < ApplicationSystemTestCase
  setup do
    @user = User.create!(email: "player@example.com", password: "password123")
  end

  test "user signs in, starts a game, makes a move, and the engine responds with analysis" do
    sign_in_as(@user)

    click_on "New game"
    assert_selector "[data-controller='chess']"

    # Board renders 64 squares.
    assert_selector "[data-square]", count: 64

    # Play 1. e4 — click the pawn, then its target square.
    find("[data-square='e2']").click
    find("[data-square='e4']").click

    # The pawn is now on e4 (white pawn glyph ♙).
    assert_selector "[data-square='e4'] span", text: "♙"

    # Stockfish replies as Black, then analyzes the new position — the eval bar text changes
    # from its "…" placeholder to a numeric score (or mate). Generous wait for the worker to
    # boot + search at depth 12.
    assert_selector "[data-chess-evaltext]", text: /[-+]?\d|Mate/, wait: 45

    # The move persisted to the game (move endpoint is called via fetch).
    game = @user.games.last
    assert_predicate game.pgn.to_s, :present?, "a move should have persisted"
    assert game.pgn.to_s.include?("e4"), "PGN should record the user's move (was #{game.pgn.inspect})"

    # The shared game-state snapshot (read by the chat widget on open) is populated with the
    # live position — this is what seeds the coach agent's prechat context.
    state = page.evaluate_script("window.__chessGameState")
    assert state, "window.__chessGameState should be published"
    assert_includes state["pgn"].to_s, "e4", "snapshot PGN should include the played move"
    assert_equal game.id, state["gameId"], "snapshot should carry the game id"
  end

  private

  def sign_in_as(user)
    visit new_user_session_path
    fill_in "Email", with: user.email
    fill_in "Password", with: "password123"
    click_on "Log in"
    assert_text "My Games"
  end
end
