require "test_helper"

# The MIAW embed is wired in the authenticated layout from the deployment registry. These tests
# pin the trust-critical behavior: the widget + its config render ONLY for a signed-in user, and
# the values come straight from the registry (so a registry edit is the single source of truth).
class AgentforceEmbedTest < ActionDispatch::IntegrationTest
  include Devise::Test::IntegrationHelpers

  setup do
    @user = User.create!(email: "embed@example.com", password: "password123")
    @deployment = AgentDeployment.default
  end

  test "signed-in user gets the agentforce controller seeded from the registry" do
    sign_in @user
    get root_path
    assert_response :success

    assert_select "body[data-controller='agentforce']"
    assert_select "body[data-agentforce-org-id-value=?]", @deployment.org_id
    assert_select "body[data-agentforce-deployment-name-value=?]", @deployment.deployment_name
    assert_select "body[data-agentforce-site-url-value=?]", @deployment.site_url
    assert_select "body[data-agentforce-scrt2-url-value=?]", @deployment.scrt2_url
    assert_select "body[data-agentforce-deployment-value=?]", @deployment.name
    # Sign-out clears the verified session (action is in the controller's scope).
    assert_select "form[data-action='submit->agentforce#endSession']"
  end

  test "anonymous visitor gets no widget and no leaked config" do
    get new_user_session_path
    assert_response :success
    assert_select "body[data-controller='agentforce']", false
    assert_select "[data-agentforce-org-id-value]", false
  end
end
