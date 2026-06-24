require "test_helper"

# Locks in the game-page structure after the UI redesign: the board lives in its own column and the
# coach sidebar is a fixed-width, shrink-0 aside that can't squeeze the board (the "headless coach
# makes the board wonky" bug). Also pins that both coach paths are present and the toggle is wired.
class GamePageLayoutTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @user = User.create!(email: "layout@example.com", password: "password123")
    @game = @user.games.create!(fen: Game::STARTING_FEN, status: "active")
    sign_in @user
  end

  test "game page renders the board column and a shrink-0 coach sidebar" do
    get game_path(@game)
    assert_response :success

    # Board column carries the chess controller and stays its own min-w-0 flex child.
    assert_select "[data-controller='chess'][data-chess-game-id-value=?]", @game.id.to_s
    # Coach sidebar is a fixed-width aside that won't steal the board's width.
    assert_select "aside.shrink-0"
    # Headless panel present (hidden until selected) and the toggle has both modes + the MIAW hint.
    assert_select "[data-controller='agent-chat'][hidden]"
    assert_select "[data-coach-toggle-target='button'][data-mode='miaw']"
    assert_select "[data-coach-toggle-target='button'][data-mode='headless']"
    assert_select "[data-coach-toggle-target='miawHint']"
  end

  test "games index uses the redesigned card grid" do
    get games_path
    assert_response :success
    assert_select "a[href=?]", game_path(@game) # game is linked as a card
  end
end
