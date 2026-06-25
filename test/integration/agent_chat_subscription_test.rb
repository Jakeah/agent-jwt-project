require "test_helper"

# The headless coach is gated on subscription IN RAILS (the Agent API session is bypassUser, so the
# agent can't see the end user). These tests prove the gate: an unsubscribed user gets the upsell
# and the Agent API is NOT called; a subscribed user's turn flows through to the agent.
#
# This minitest build ships no stub/mock helpers, so we swap the collaborators' methods directly and
# restore them in `ensure` — dependency-free and explicit.
class AgentChatSubscriptionTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @user = User.create!(email: "gate_#{SecureRandom.hex(4)}@example.com", password: "password123")
    @game = @user.games.create!(fen: Game::STARTING_FEN, status: "active")
    sign_in @user
  end

  test "unsubscribed user gets the upsell and the Agent API is never called" do
    agent_was_called = false
    with_subscription(false) do
      with_agent_client(->(**) { agent_was_called = true; { "messages" => [] } }) do
        post message_game_agent_chat_path(@game), params: { text: "coach me" }, as: :json
      end
    end

    assert_response :success
    body = JSON.parse(response.body)
    assert body["gated"], "response must be flagged gated"
    assert_match(/subscription/i, body["reply"])
    assert_not agent_was_called, "the Agent API must not be called for an unsubscribed user"
  end

  test "subscribed user's turn reaches the agent" do
    with_subscription(true) do
      with_agent_client(->(**) { { "messages" => [{ "message" => "Nice opening!" }] } }) do
        # Avoid a real Salesforce session start by seeding the cached handle.
        Rails.cache.write("agent_session:#{@user.id}:#{@game.id}",
                          { session_id: "sess1", sequence: 0, external_key: "k" })
        post message_game_agent_chat_path(@game), params: { text: "coach me" }, as: :json
      end
    end

    assert_response :success
    body = JSON.parse(response.body)
    assert_nil body["gated"], "subscribed turn must not be gated"
    assert_equal "Nice opening!", body["reply"]
  end

  private

  # Swap Subscription.active? for the duration of the block.
  def with_subscription(value)
    original = Subscription.method(:active?)
    Subscription.define_singleton_method(:active?) { |_email| value }
    yield
  ensure
    Subscription.define_singleton_method(:active?, original)
  end

  # Swap AgentApiClient.new to return a fake whose send_message runs the given proc. end_session is
  # a no-op so destroy/teardown won't blow up.
  def with_agent_client(send_proc)
    fake = Class.new do
      define_method(:send_message) { |**kwargs| send_proc.call(**kwargs) }
      # Lazy session creation may run if the cache handle isn't present — return a usable sessionId.
      def start_session(**) = { "sessionId" => "test-session" }
      def end_session(**) = nil
    end.new
    original = AgentApiClient.method(:new)
    AgentApiClient.define_singleton_method(:new) { |*, **| fake }
    yield
  ensure
    AgentApiClient.define_singleton_method(:new, original)
  end
end
