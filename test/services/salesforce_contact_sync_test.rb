require "test_helper"

# SalesforceContactSync upserts a subscribed Contact by email — PATCH if one exists, POST if not —
# idempotently. We inject a fake SalesforceQuery (this minitest build has no stub lib) that records
# calls, so no live HTTP is made.
class SalesforceContactSyncTest < ActiveSupport::TestCase
  # Records query/create/update calls; query returns whatever `existing` is seeded with.
  class FakeClient
    attr_reader :calls
    def initialize(existing_id: nil)
      @existing_id = existing_id
      @calls = []
    end

    def query(soql)
      @calls << [:query, soql]
      { "records" => @existing_id ? [{ "Id" => @existing_id }] : [] }
    end

    def create(sobject, fields)
      @calls << [:create, sobject, fields]
      { "id" => "003NEW000000001", "success" => true }
    end

    def update(sobject, id, fields)
      @calls << [:update, sobject, id, fields]
      {}
    end
  end

  test "creates a new subscribed Contact when none exists" do
    fake = FakeClient.new(existing_id: nil)
    id = SalesforceContactSync.new(client: fake).upsert_subscribed(email: "fresh@example.com")

    assert_equal "003NEW000000001", id
    create = fake.calls.find { |c| c[0] == :create }
    assert create, "should POST a new Contact"
    assert_equal "Contact", create[1]
    assert_equal true, create[2]["Is_Subscribed__c"]
    assert_equal "fresh@example.com", create[2]["Email"]
    assert_equal "Fresh", create[2]["LastName"] # derived from the email local part
    assert fake.calls.none? { |c| c[0] == :update }, "must not PATCH when creating"
  end

  test "updates the existing Contact (no duplicate) when one exists" do
    fake = FakeClient.new(existing_id: "003EXISTING0001")
    id = SalesforceContactSync.new(client: fake).upsert_subscribed(email: "known@example.com")

    assert_equal "003EXISTING0001", id
    update = fake.calls.find { |c| c[0] == :update }
    assert update, "should PATCH the existing Contact"
    assert_equal "003EXISTING0001", update[2]
    assert_equal true, update[3]["Is_Subscribed__c"]
    assert fake.calls.none? { |c| c[0] == :create }, "must not create a duplicate"
  end

  test "busts the subscription cache so the new user can coach immediately" do
    Rails.cache.write("subscription:active:cache@example.com", false)
    SalesforceContactSync.new(client: FakeClient.new).upsert_subscribed(email: "cache@example.com")
    assert_nil Rails.cache.read("subscription:active:cache@example.com")
  end

  test "raises on blank email" do
    assert_raises(SalesforceContactSync::Error) do
      SalesforceContactSync.new(client: FakeClient.new).upsert_subscribed(email: "")
    end
  end
end
