require "test_helper"

# Sign-up is invite-gated: a new account is created only when signup_code matches SIGNUP_CODE
# (default "astro-chess"). On success the User#after_create_commit hook enqueues EnsureContactJob to
# provision a subscribed Salesforce Contact. These tests pin the gate and the enqueue.
class SignupPasscodeTest < ActionDispatch::IntegrationTest
  include ActiveJob::TestHelper

  def signup(code:, email: "newbie_#{SecureRandom.hex(4)}@example.com")
    post user_registration_path, params: {
      user: { email: email, password: "password123", password_confirmation: "password123", signup_code: code },
    }
    email
  end

  test "correct invite code creates the account and enqueues Contact provisioning" do
    assert_enqueued_with(job: EnsureContactJob) do
      assert_difference("User.count", 1) do
        signup(code: "astro-chess")
      end
    end
  end

  test "wrong invite code is rejected (no user, no job)" do
    assert_no_enqueued_jobs only: EnsureContactJob do
      assert_no_difference("User.count") do
        signup(code: "nope")
      end
    end
    assert_response :unprocessable_entity
    assert_match(/invite code/i, response.body)
  end

  test "blank invite code is rejected" do
    assert_no_difference("User.count") do
      signup(code: "")
    end
    assert_response :unprocessable_entity
  end

  test "SIGNUP_CODE env overrides the default" do
    prev = ENV["SIGNUP_CODE"]
    ENV["SIGNUP_CODE"] = "custom-code-123"
    begin
      assert_no_difference("User.count") { signup(code: "astro-chess") } # old default no longer valid
      assert_difference("User.count", 1) { signup(code: "custom-code-123") }
    ensure
      prev.nil? ? ENV.delete("SIGNUP_CODE") : ENV["SIGNUP_CODE"] = prev
    end
  end
end
