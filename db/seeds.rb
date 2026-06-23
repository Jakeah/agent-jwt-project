# This file should ensure the existence of records required to run the application in every environment (production,
# development, test). The code here should be idempotent so that it can be executed at any point in every environment.
# The data can then be loaded with the bin/rails db:seed command (or created alongside the database with db:setup).
#
# Example:
#
#   ["Action", "Comedy", "Drama", "Horror"].each do |genre_name|
#     MovieGenre.find_or_create_by!(name: genre_name)
#   end

# Demo player for the verified-identity walkthrough. The email matches the seeded Salesforce
# Contact (Jordan Player / player@example.com), so when this user signs in and opens the chat,
# MIAW User Verification binds the conversation to that Contact and the coach greets "Jordan".
# Password comes from DEMO_USER_PASSWORD (a Heroku config var) — never hardcoded in the repo.
demo_email = "player@example.com"
demo_password = ENV["DEMO_USER_PASSWORD"]

if demo_password.present?
  user = User.find_or_initialize_by(email: demo_email)
  user.password = demo_password
  user.save!
  puts "seed: demo user #{demo_email} ready"
else
  puts "seed: DEMO_USER_PASSWORD not set — skipping demo user"
end
