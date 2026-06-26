class User < ApplicationRecord
  # Include default devise modules. Others available are:
  # :confirmable, :lockable, :timeoutable, :trackable and :omniauthable
  devise :database_authenticatable, :registerable,
         :recoverable, :rememberable, :validatable

  has_many :games, dependent: :destroy

  # On signup, provision a subscribed Salesforce Contact so the new player can use the coach
  # (coaching is gated on Contact.Is_Subscribed__c). Enqueued after the DB commit so a rolled-back
  # signup never provisions, and so a Salesforce round-trip (or outage) never blocks/fails account
  # creation — the job upserts idempotently and retries on transient errors.
  after_create_commit :provision_salesforce_contact

  private

  def provision_salesforce_contact
    EnsureContactJob.perform_later(email)
  end
end
